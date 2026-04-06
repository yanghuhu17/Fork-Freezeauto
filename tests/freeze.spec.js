const { test, expect, chromium } = require('@playwright/test');
const https = require('https');
const { authenticator } = require('otplib');

const RAW_ACCOUNTS = process.env.DISCORD_ACCOUNTS || '';
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

// 🛡️ 暴力清除广告
async function killAllAds(page) {
    try {
        await page.evaluate(() => {
            document.querySelectorAll('iframe').forEach(iframe => {
                if (iframe.id.includes('google') || iframe.src.includes('ads') || iframe.id.includes('vignette') || iframe.name.includes('google')) {
                    iframe.remove();
                }
            });
            document.querySelectorAll('.fc-dialog-overlay, .fc-message-root').forEach(el => el.remove());
        });
        const adCloseSelectors = ['button[aria-label="Close"]', '.close-button', 'div[class*="ad"] button[class*="close"]'];
        for (const selector of adCloseSelectors) {
            const closeBtn = page.locator(selector).first();
            if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
                await closeBtn.click({ force: true });
                await page.waitForTimeout(500);
            }
        }
    } catch { }
}

// 📨 发送 TG 消息
function sendTG(fullReport) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const req = https.request({
            hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST', headers: { 'Content-Type': 'application/json' },
        }, () => resolve());
        req.on('error', () => resolve());
        req.setTimeout(10000, () => { req.destroy(); resolve(); });
        req.write(JSON.stringify({ chat_id: TG_CHAT_ID, text: fullReport }));
        req.end();
    });
}

// ⏱️ 获取并解析网页上的剩余时间
async function getRemainingTime(page) {
    const text = await page.evaluate(() => document.getElementById('renewal-status-console')?.innerText.trim());
    if (!text) return { text: "获取失败", totalDays: 0 };
    const daysMatch = text.match(/(\d+(?:\.\d+)?)\s*day/i);
    const hoursMatch = text.match(/(\d+(?:\.\d+)?)\s*hour/i);
    const days = daysMatch ? parseInt(daysMatch[1]) : 0;
    const hoursRaw = hoursMatch ? parseFloat(hoursMatch[1]) : 0;
    const hours = Math.floor(hoursRaw);
    const minutes = Math.round((hoursRaw - hours) * 60);
    return {
        text: `${days}天 ${hours}小时 ${minutes}分钟`,
        totalDays: days + (hoursRaw / 24)
    };
}

// 🔍 调试：打印页面上所有可交互元素的文字（用于定位真实选择器）
async function debugDumpClickables(page, label) {
    const info = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], [tabindex]'));
        return els.map(el => ({
            tag: el.tagName,
            text: el.innerText?.trim().slice(0, 80),
            role: el.getAttribute('role'),
            id: el.id,
            cls: el.className?.slice(0, 60),
        })).filter(e => e.text);
    });
    console.log(`\n🔍 [${label}] 当前页面可交互元素：`);
    info.forEach(e => console.log(`  [${e.tag}] id="${e.id}" | text="${e.text}" | role="${e.role}" | class="${e.cls}"`));
    console.log('');
}

// 🖱️ 通用宽松点击：按文字片段查找任意可点击元素
async function clickByText(page, texts, timeoutMs = 8000) {
    // texts 是数组，按优先级依次尝试
    for (const text of texts) {
        try {
            // 精确子串匹配，覆盖 button/a/div/li/span 等所有标签
            const loc = page.locator(`button, a, [role="button"], [role="link"], li, div[tabindex], span[tabindex]`)
                .filter({ hasText: text })
                .first();
            if (await loc.isVisible({ timeout: timeoutMs }).catch(() => false)) {
                await loc.click({ force: true });
                console.log(`  ✅ 已点击: "${text}"`);
                return true;
            }
        } catch { }
    }
    return false;
}

// 🔐 处理 Discord 登录后的所有 MFA 情况
async function handleMFA(page, twoFaSecret) {
    // 等待页面稳定
    await page.waitForTimeout(3000);

    // ── 检测是否在 Discord 登录域 ──
    const currentUrl = page.url();
    if (!currentUrl.includes('discord.com')) {
        console.log('ℹ️ 已跳出 Discord，无需处理 MFA');
        return;
    }

    // ── 调试：打印当前页面所有可点击元素 ──
    await debugDumpClickables(page, '登录后');

    // ── 检测页面文字，判断 MFA 类型 ──
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log(`📄 页面文字片段: ${bodyText.slice(0, 300).replace(/\n/g, ' | ')}`);

    const isMfaPage = /多重认证|Multi-Factor Authentication|Two-factor authentication|两步验证/i.test(bodyText);
    const hasPasskeyPrompt = /通行密钥|passkey|security key|安全密钥/i.test(bodyText);
    const alreadyHas6digitInput = await page.locator([
        'input[autocomplete="one-time-code"]',
        'input[maxlength="6"]',
        'input[placeholder*="6"]',
        'input[placeholder*="验证码"]',
        'input[placeholder*="digit"]',
    ].join(', ')).first().isVisible({ timeout: 1000 }).catch(() => false);

    console.log(`  isMfaPage=${isMfaPage} | hasPasskeyPrompt=${hasPasskeyPrompt} | alreadyHas6digitInput=${alreadyHas6digitInput}`);

    // ── 如果已经直接显示 6 位输入框，跳过切换步骤 ──
    if (!alreadyHas6digitInput && isMfaPage) {

        if (hasPasskeyPrompt) {
            console.log('🔑 检测到通行密钥页面，尝试切换到验证器...');
        } else {
            console.log('🔑 检测到 MFA 页面，尝试切换到验证器...');
        }

        // ── 第一步：点击「以其他方式验证 / Verify with something else」──
        const clickedOther = await clickByText(page, [
            '以其他方式验证',
            'Verify with something else',
            '其他验证方式',
            'Use a different method',
            '使用其他方法',
            '其他方式',
        ]);

        if (clickedOther) {
            await page.waitForTimeout(2000);
            // 再次调试打印，看切换后出现了什么
            await debugDumpClickables(page, '点击「其他方式」后');

            // ── 第二步：点击「使用验证器 / Use your authenticator app」──
            const clickedAuth = await clickByText(page, [
                '使用验证器',
                'Use your authenticator app',
                'Authenticator app',
                '验证器应用',
                '身份验证器',
                'TOTP',
            ]);

            if (clickedAuth) {
                await page.waitForTimeout(2000);
                await debugDumpClickables(page, '点击「使用验证器」后');
            } else {
                console.warn('⚠️ 未找到「使用验证器」，查看上方调试输出确认实际按钮文字');
            }
        } else {
            console.warn('⚠️ 未找到「以其他方式验证」，查看上方调试输出确认实际按钮文字');
        }
    }

    // ── 最终统一处理 6 位验证码输入 ──
    const twoFaInput = page.locator([
        'input[autocomplete="one-time-code"]',
        'input[maxlength="6"]',
        'input[placeholder*="6-digit"]',
        'input[placeholder*="6位"]',
        'input[placeholder*="验证码"]',
        'input[placeholder*="digit"]',
        'input[type="text"][maxlength]',
    ].join(', ')).first();

    const has2FA = await twoFaInput.waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false);

    if (has2FA) {
        if (!twoFaSecret) throw new Error('❌ 触发了 2FA/MFA，但未配置该账号的 2FA 秘钥 (格式: 账号,密码,秘钥)');
        console.log('🔐 正在自动计算并填写 6 位验证码...');
        const token = authenticator.generate(twoFaSecret.replace(/\s/g, ''));
        await twoFaInput.fill(token);
        await page.waitForTimeout(500);

        // 提交：优先 type=submit，兼容各种文字按钮
        const submitBtn = page.locator([
            'button[type="submit"]',
            'button:has-text("登录")',
            'button:has-text("Log In")',
            'button:has-text("Submit")',
            'button:has-text("确认")',
            'button:has-text("Confirm")',
            'button:has-text("继续")',
            'button:has-text("Continue")',
        ].join(', ')).first();

        await submitBtn.click();
        await page.waitForTimeout(4000);
        console.log('✅ 验证码已提交');
    } else {
        // 最后再打印一次，帮助排查
        await debugDumpClickables(page, '未找到输入框时');
        console.log('ℹ️ 未检测到 6 位输入框，跳过 MFA（或页面结构需根据上方调试输出调整）');
    }
}

test('FreezeHost 多账号全自动续期', async () => {
    test.setTimeout(0);

    if (!RAW_ACCOUNTS) throw new Error('❌ 缺少 DISCORD_ACCOUNTS 环境变量');

    const accounts = RAW_ACCOUNTS.split(/[\n|]/).map(l => l.trim()).filter(l => l.length > 0);
    console.log(`✅ 检测到 ${accounts.length} 个账号，准备执行...`);

    let proxyConfig = process.env.GOST_PROXY ? { server: process.env.GOST_PROXY } : undefined;
    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });

    let finalTgBlocks = [];

    for (let i = 0; i < accounts.length; i++) {
        const [email, password, twoFaSecret] = accounts[i].split(',').map(s => s?.trim());
        if (!email || !password) continue;

        const safeEmail = email.replace(/(.{2})(.*)(@.*)/, '$1***$3');
        console.log(`\n=========================================`);
        console.log(`🚀 开始处理: ${safeEmail}`);
        console.log(`=========================================`);

        let accReportLines = [];
        let coinBalance = "未知";
        let discordUser = safeEmail;

        const context = await browser.newContext();
        const page = await context.newPage();
        page.setDefaultTimeout(TIMEOUT);

        try {
            console.log('🔑 访问并登录 FreezeHost...');
            await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });
            await page.click('span.text-lg:has-text("Login with Discord")');
            await page.locator('button#confirm-login').waitFor({ state: 'visible' });
            await page.click('button#confirm-login');

            await page.waitForURL(/discord\.com\/login/, { timeout: 30000 });
            await page.fill('input[name="email"]', email);
            await page.fill('input[name="password"]', password);
            await page.click('button[type="submit"]');

            // 🔐 统一 MFA 处理
            await handleMFA(page, twoFaSecret);

            // 授权页（如出现）
            await page.waitForTimeout(5000);
            const authBtn = page.locator('button:has-text("Authorize"), button:has-text("授权")');
            if (await authBtn.isVisible().catch(() => false)) await authBtn.click();

            await page.waitForURL(/free\.freezehost\.pro\/dashboard/, { timeout: 30000 });
            console.log('✅ 登录成功！');
            await page.waitForTimeout(4000);

            // 获取用户名和余额
            try {
                const fetchedData = await page.evaluate(() => {
                    const text = document.body.innerText;
                    const userMatch = text.match(/@[\w_.-]+/);
                    const match1 = text.match(/AVAILABLE BALANCE\s*([\d,]+)/i);
                    const match2 = text.match(/([\d,]+)\s*GLOBAL CURRENCY/i);
                    const match3 = text.match(/([\d,]+)\s*COINS/i);
                    return {
                        user: userMatch ? userMatch[0] : null,
                        coins: match1 ? match1[1] : (match2 ? match2[1] : (match3 ? match3[1] : "未知"))
                    };
                });
                if (fetchedData.user) discordUser = fetchedData.user;
                coinBalance = fetchedData.coins;
                console.log(`👤 用户名: ${discordUser} | 💰 金币: ${coinBalance}`);
            } catch (e) { }

            // 获取服务器列表
            const servers = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="server-console"]'));
                return links.map((link, idx) => {
                    let el = link; let cardText = '';
                    while (el && el.tagName !== 'BODY') {
                        if (el.innerText && (el.innerText.includes('ID:') || el.innerText.includes('Node:'))) {
                            cardText = el.innerText; break;
                        }
                        el = el.parentElement;
                    }
                    let name = `服务器-${idx + 1}`;
                    if (cardText) {
                        const lines = cardText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                        if (lines.length > 0) name = lines[0];
                    }
                    return { name: name.toUpperCase(), url: link.href };
                });
            });

            if (servers.length === 0) {
                accReportLines.push(`⚠️ 未发现任何服务器`);
            } else {
                for (const srv of servers) {
                    console.log(`  ▶️ 检查: [${srv.name}]`);
                    await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(3000);

                    let preTime = await getRemainingTime(page);
                    if (preTime.totalDays > 7) {
                        accReportLines.push(`${srv.name} : ⏳ 未到期 (剩余: ${preTime.text})`);
                        continue;
                    }

                    console.log(`  ✅ 准备续费 [${srv.name}] ...`);
                    await killAllAds(page);

                    const clickedIcon = await page.evaluate(() => {
                        const icons = document.querySelectorAll('i.fa-external-link-alt');
                        for (let icon of icons) {
                            let parent = icon.parentElement;
                            if (parent && parent.outerHTML.includes('reviewAction')) continue;
                            if (parent) { parent.click(); return true; }
                        }
                        return false;
                    });

                    if (clickedIcon) {
                        await page.waitForTimeout(3000);
                        await killAllAds(page);

                        const renewBtn = page.locator('#renew-link-modal');
                        await renewBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

                        if (await renewBtn.isVisible()) {
                            const btnText = (await renewBtn.innerText()).trim();
                            if (btnText.toLowerCase().includes('renew instance')) {
                                await page.waitForTimeout(1500);

                                const realRenewBtn = page.locator('a:has-text("RENEW INSTANCE"), button:has-text("RENEW INSTANCE")').first();
                                if (await realRenewBtn.isVisible()) {
                                    await realRenewBtn.hover();
                                    await page.waitForTimeout(300);
                                    await realRenewBtn.click({ delay: 150 });
                                } else {
                                    await page.locator('text="RENEW INSTANCE"').last().click({ delay: 150 });
                                }

                                await page.waitForTimeout(6000);

                                if (page.url().includes('err=CANNOTAFFORDRENEWAL')) {
                                    accReportLines.push(`${srv.name} : ❌ 余额不足`);
                                    continue;
                                }

                                let success = false;
                                let postTime;
                                console.log(`  🔄 开始验证时间更新...`);

                                for (let retry = 0; retry < 3; retry++) {
                                    await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
                                    await page.waitForTimeout(4000);
                                    postTime = await getRemainingTime(page);
                                    if (postTime.totalDays > preTime.totalDays) { success = true; break; }
                                    console.log(`  ⏳ 数据未同步，等待 5 秒后重试 (${retry + 1}/3)...`);
                                    await page.waitForTimeout(5000);
                                }

                                if (success) {
                                    accReportLines.push(`${srv.name} : ✅ 成功续期 (最新剩余: ${postTime.text})`);
                                } else {
                                    accReportLines.push(`${srv.name} : ✅ 续期指令已发送 (面板刷新延迟，当前: ${postTime.text})`);
                                }
                            } else {
                                accReportLines.push(`${srv.name} : ⏳ 未到期 (按钮: ${btnText})`);
                            }
                        } else {
                            accReportLines.push(`${srv.name} : ⚠️ 弹窗未显示`);
                        }
                    } else {
                        accReportLines.push(`${srv.name} : ⚠️ 未找到续期图标`);
                    }
                }
            }

        } catch (e) {
            console.error(`❌ 账号异常: ${e.message}`);
            accReportLines.push(`❌ 运行异常: ${e.message}`);
        } finally {
            let accountBlock = `🎮 FreezeHost ${discordUser} 续期报告\n\n` +
                accReportLines.join('\n') + `\n\n` +
                `💰 账户余额：${coinBalance} 金币`;
            finalTgBlocks.push(accountBlock);
            await context.close();
        }
    }

    if (finalTgBlocks.length > 0) {
        let finalMessage = finalTgBlocks.join('\n\n➖➖➖➖➖➖➖➖➖➖\n\n') + `\n\n官网地址：https://free.freezehost.pro/`;
        await sendTG(finalMessage);
    }
    await browser.close();
});
