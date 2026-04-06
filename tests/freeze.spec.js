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
        }, (res) => resolve());

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

// 🔐 处理 Discord 登录后的所有 MFA 情况（通行密钥 / 直接2FA / 中英文界面）
async function handleMFA(page, twoFaSecret) {
    await page.waitForTimeout(3000);

    // ── 第一步：检测是否出现了 MFA 主页面（通行密钥默认弹出的页面）──
    const mfaHeading = page.locator([
        'h1:has-text("多重认证")',
        'h1:has-text("Multi-Factor Authentication")',
        'h2:has-text("多重认证")',
        'h2:has-text("Multi-Factor Authentication")',
        // Discord 有时用 div 而非 h 标签
        'div:has-text("多重认证")',
        'div:has-text("Multi-Factor Authentication")',
    ].join(', ')).first();

    const isMfaPage = await mfaHeading.isVisible({ timeout: 5000 }).catch(() => false);

    if (isMfaPage) {
        console.log('🔑 检测到 MFA 主页（通行密钥模式），尝试切换到验证器...');

        // ── 第二步：点击「以其他方式验证」/ 「Verify with something else」──
        const otherWayBtn = page.locator([
            'button:has-text("以其他方式验证")',
            'button:has-text("Verify with something else")',
            'a:has-text("以其他方式验证")',
            'a:has-text("Verify with something else")',
            // 兜底：文字节点匹配
            'text="以其他方式验证"',
            'text="Verify with something else"',
        ].join(', ')).first();

        const hasOtherWay = await otherWayBtn.isVisible({ timeout: 8000 }).catch(() => false);

        if (hasOtherWay) {
            await otherWayBtn.click();
            await page.waitForTimeout(1500);
            console.log('✅ 已点击「以其他方式验证」');

            // ── 第三步：点击「使用验证器」/ 「Use your authenticator app」──
            const useAuthBtn = page.locator([
                'button:has-text("使用验证器")',
                'button:has-text("Use your authenticator app")',
                'div[class*="option"]:has-text("使用验证器")',
                'div[class*="option"]:has-text("Use your authenticator app")',
                'li:has-text("使用验证器")',
                'li:has-text("Use your authenticator app")',
                // 兜底：文字节点匹配
                'text="使用验证器"',
                'text="Use your authenticator app"',
            ].join(', ')).first();

            const hasAuthApp = await useAuthBtn.isVisible({ timeout: 8000 }).catch(() => false);

            if (hasAuthApp) {
                await useAuthBtn.click();
                await page.waitForTimeout(1500);
                console.log('✅ 已切换至验证器输入页');
            } else {
                console.warn('⚠️ 未找到「使用验证器」按钮，尝试直接查找 6 位输入框...');
            }
        } else {
            console.warn('⚠️ 未找到「以其他方式验证」按钮，尝试直接查找 6 位输入框...');
        }
    }

    // ── 第四步：无论走哪条路，最终都统一处理 6 位验证码输入──
    // 兼容：直接弹 2FA、通行密钥绕过后、中英文界面
    const twoFaInput = page.locator([
        'input[autocomplete="one-time-code"]',
        'input[placeholder*="6-digit"]',
        'input[placeholder*="6位"]',
        'input[placeholder*="验证码"]',
        'input[maxlength="6"]',
    ].join(', ')).first();

    const has2FA = await twoFaInput.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);

    if (has2FA) {
        if (!twoFaSecret) {
            throw new Error('❌ 触发了 2FA / MFA，但未配置该账号的 2FA 秘钥 (格式: 账号,密码,秘钥)');
        }
        console.log('🔐 正在自动计算并填写 6 位验证码...');
        const token = authenticator.generate(twoFaSecret.replace(/\s/g, ''));
        await twoFaInput.fill(token);
        await page.waitForTimeout(500);

        // 提交按钮：兼容中英文
        const submitBtn = page.locator([
            'button[type="submit"]',
            'button:has-text("登录")',
            'button:has-text("Log In")',
            'button:has-text("Submit")',
            'button:has-text("确认")',
            'button:has-text("Confirm")',
        ].join(', ')).first();

        await submitBtn.click();
        await page.waitForTimeout(4000);
        console.log('✅ 验证码已提交');
    } else {
        console.log('ℹ️ 未检测到 2FA 输入框，跳过 MFA 处理（可能账号无 2FA）');
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

            // 🔐 统一 MFA 处理（兼容：无2FA / 直接2FA / 通行密钥绕过2FA / 中英文界面）
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

                                    if (postTime.totalDays > preTime.totalDays) {
                                        success = true;
                                        break;
                                    }

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
