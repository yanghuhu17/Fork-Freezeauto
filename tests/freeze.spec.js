const { test, chromium } = require('@playwright/test');
const https = require('https');
const { authenticator } = require('otplib');

const RAW_ACCOUNTS = process.env.DISCORD_ACCOUNTS || '';
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');
const TIMEOUT = 120000;

async function killAllAds(page) {
    try {
        await page.evaluate(() => {
            document.querySelectorAll('iframe').forEach(iframe => {
                if (iframe.id.includes('google') || iframe.src.includes('ads') || iframe.id.includes('vignette') || iframe.name.includes('google'))
                    iframe.remove();
            });
            document.querySelectorAll('.fc-dialog-overlay, .fc-message-root').forEach(el => el.remove());
        });
        for (const sel of ['button[aria-label="Close"]', '.close-button', 'div[class*="ad"] button[class*="close"]']) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                await btn.click({ force: true });
                await page.waitForTimeout(500);
            }
        }
    } catch { }
}

function sendTG(text) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const req = https.request({
            hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST', headers: { 'Content-Type': 'application/json' },
        }, () => resolve());
        req.on('error', () => resolve());
        req.setTimeout(10000, () => { req.destroy(); resolve(); });
        req.write(JSON.stringify({ chat_id: TG_CHAT_ID, text }));
        req.end();
    });
}

async function getRemainingTime(page) {
    const text = await page.evaluate(() => document.getElementById('renewal-status-console')?.innerText.trim());
    if (!text) return { text: '获取失败', totalDays: 0 };
    const days = parseInt(text.match(/(\d+(?:\.\d+)?)\s*day/i)?.[1] || 0);
    const hoursRaw = parseFloat(text.match(/(\d+(?:\.\d+)?)\s*hour/i)?.[1] || 0);
    const hours = Math.floor(hoursRaw);
    const minutes = Math.round((hoursRaw - hours) * 60);
    return { text: `${days}天 ${hours}小时 ${minutes}分钟`, totalDays: days + hoursRaw / 24 };
}

// 🔐 处理 MFA：通行密钥默认页 → 切换验证器 → 填写6位码
async function handleMFA(page, twoFaSecret) {
    await page.waitForTimeout(3000);
    if (!page.url().includes('discord.com')) return;

    // 检测是否出现通行密钥默认 MFA 页（有「Verify with something else」按钮）
    const otherWayBtn = page.locator('[role="button"]:has-text("Verify with something else"), button:has-text("Verify with something else")').first();
    if (await otherWayBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('🔑 检测到通行密钥 MFA 页，切换到验证器...');
        await otherWayBtn.click();
        await page.waitForTimeout(1500);

        // 选择「Use your authenticator app」
        const authAppBtn = page.locator('[role="button"]:has-text("Use your authenticator app")').first();
        await authAppBtn.waitFor({ state: 'visible', timeout: 8000 });
        await authAppBtn.click();
        await page.waitForTimeout(1500);
        console.log('✅ 已切换至验证器输入页');
    }

    // 统一处理 6 位验证码（直接 2FA 或通行密钥切换后都走这里）
    const codeInput = page.locator([
        'input[autocomplete="one-time-code"]',
        'input[maxlength="6"]',
        'input[placeholder*="6-digit"]',
        'input[placeholder*="digit"]',
        'input[placeholder*="验证码"]',
    ].join(', ')).first();

    if (!await codeInput.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) {
        console.log('ℹ️ 未检测到 2FA 输入框，跳过');
        return;
    }

    if (!twoFaSecret) throw new Error('❌ 触发了 2FA/MFA，但未配置该账号的 2FA 秘钥 (格式: 账号,密码,秘钥)');
    console.log('🔐 正在填写 6 位验证码...');
    await codeInput.fill(authenticator.generate(twoFaSecret.replace(/\s/g, '')));
    await page.waitForTimeout(500);

    // 提交（日志确认按钮文字为 Confirm）
    const submitBtn = page.locator([
        'button:has-text("Confirm")',
        'button:has-text("确认")',
        'button:has-text("Log In")',
        'button:has-text("登录")',
        'button[type="submit"]',
    ].join(', ')).first();
    await submitBtn.click();
    await page.waitForTimeout(4000);
    console.log('✅ 验证码已提交');
}

test('FreezeHost 多账号全自动续期', async () => {
    test.setTimeout(0);
    if (!RAW_ACCOUNTS) throw new Error('❌ 缺少 DISCORD_ACCOUNTS 环境变量');

    const accounts = RAW_ACCOUNTS.split(/[\n|]/).map(l => l.trim()).filter(Boolean);
    console.log(`✅ 检测到 ${accounts.length} 个账号，准备执行...`);

    const browser = await chromium.launch({
        headless: true,
        proxy: process.env.GOST_PROXY ? { server: process.env.GOST_PROXY } : undefined,
    });

    const finalTgBlocks = [];

    for (const account of accounts) {
        const [email, password, twoFaSecret] = account.split(',').map(s => s?.trim());
        if (!email || !password) continue;

        const safeEmail = email.replace(/(.{2})(.*)(@.*)/, '$1***$3');
        console.log(`\n=========================================`);
        console.log(`🚀 开始处理: ${safeEmail}`);
        console.log(`=========================================`);

        const accReportLines = [];
        let coinBalance = '未知';
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

            await handleMFA(page, twoFaSecret);

            // 授权页
            await page.waitForTimeout(5000);
            const authBtn = page.locator('button:has-text("Authorize"), button:has-text("授权")').first();
            if (await authBtn.isVisible().catch(() => false)) await authBtn.click();

            await page.waitForURL(/free\.freezehost\.pro\/dashboard/, { timeout: 30000 });
            console.log('✅ 登录成功！');
            await page.waitForTimeout(4000);

            // 用户名 & 余额
            try {
                const data = await page.evaluate(() => {
                    const text = document.body.innerText;
                    return {
                        user: text.match(/@[\w_.-]+/)?.[0] ?? null,
                        coins: (
                            text.match(/AVAILABLE BALANCE\s*([\d,]+)/i) ||
                            text.match(/([\d,]+)\s*GLOBAL CURRENCY/i) ||
                            text.match(/([\d,]+)\s*COINS/i)
                        )?.[1] ?? '未知',
                    };
                });
                if (data.user) discordUser = data.user;
                coinBalance = data.coins;
                console.log(`👤 用户名: ${discordUser} | 💰 金币: ${coinBalance}`);
            } catch { }

            // 服务器列表
            const servers = await page.evaluate(() =>
                Array.from(document.querySelectorAll('a[href*="server-console"]')).map((link, idx) => {
                    let el = link, cardText = '';
                    while (el && el.tagName !== 'BODY') {
                        if (el.innerText?.includes('ID:') || el.innerText?.includes('Node:')) { cardText = el.innerText; break; }
                        el = el.parentElement;
                    }
                    const lines = cardText.split('\n').map(l => l.trim()).filter(Boolean);
                    return { name: (lines[0] ?? `服务器-${idx + 1}`).toUpperCase(), url: link.href };
                })
            );

            if (!servers.length) {
                accReportLines.push('⚠️ 未发现任何服务器');
            } else {
                for (const srv of servers) {
                    console.log(`  ▶️ 检查: [${srv.name}]`);
                    await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(3000);

                    const preTime = await getRemainingTime(page);
                    if (preTime.totalDays > 7) {
                        accReportLines.push(`${srv.name} : ⏳ 未到期 (剩余: ${preTime.text})`);
                        continue;
                    }

                    console.log(`  ✅ 准备续费 [${srv.name}] ...`);
                    await killAllAds(page);

                    const clickedIcon = await page.evaluate(() => {
                        for (const icon of document.querySelectorAll('i.fa-external-link-alt')) {
                            const parent = icon.parentElement;
                            if (parent && !parent.outerHTML.includes('reviewAction')) { parent.click(); return true; }
                        }
                        return false;
                    });

                    if (!clickedIcon) { accReportLines.push(`${srv.name} : ⚠️ 未找到续期图标`); continue; }

                    await page.waitForTimeout(3000);
                    await killAllAds(page);

                    const renewBtn = page.locator('#renew-link-modal');
                    await renewBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

                    if (!await renewBtn.isVisible()) { accReportLines.push(`${srv.name} : ⚠️ 弹窗未显示`); continue; }

                    const btnText = (await renewBtn.innerText()).trim();
                    if (!btnText.toLowerCase().includes('renew instance')) {
                        accReportLines.push(`${srv.name} : ⏳ 未到期 (按钮: ${btnText})`);
                        continue;
                    }

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

                    let success = false, postTime;
                    console.log(`  🔄 开始验证时间更新...`);
                    for (let retry = 0; retry < 3; retry++) {
                        await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(4000);
                        postTime = await getRemainingTime(page);
                        if (postTime.totalDays > preTime.totalDays) { success = true; break; }
                        console.log(`  ⏳ 数据未同步，重试 (${retry + 1}/3)...`);
                        await page.waitForTimeout(5000);
                    }

                    accReportLines.push(success
                        ? `${srv.name} : ✅ 成功续期 (最新剩余: ${postTime.text})`
                        : `${srv.name} : ✅ 续期指令已发送 (面板刷新延迟，当前: ${postTime.text})`
                    );
                }
            }
        } catch (e) {
            console.error(`❌ 账号异常: ${e.message}`);
            accReportLines.push(`❌ 运行异常: ${e.message}`);
        } finally {
            finalTgBlocks.push(
                `🎮 FreezeHost ${discordUser} 续期报告\n\n` +
                accReportLines.join('\n') +
                `\n\n💰 账户余额：${coinBalance} 金币`
            );
            await context.close();
        }
    }

    if (finalTgBlocks.length) {
        await sendTG(finalTgBlocks.join('\n\n➖➖➖➖➖➖➖➖➖➖\n\n') + '\n\n官网地址：https://free.freezehost.pro/');
    }
    await browser.close();
});
