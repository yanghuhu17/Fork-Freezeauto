const { test, expect, chromium } = require('@playwright/test');
const https = require('https');
const { authenticator } = require('otplib');

const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');
const DISCORD_2FA = process.env.DISCORD_2FA || '';

async function sendTG(result) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const msg = `🎮 FreezeHost 续期通知\n📊 结果: ${result}`;
    const req = https.request({
        hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`,
        method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    req.write(JSON.stringify({ chat_id: TG_CHAT_ID, text: msg })); 
    req.end();
}

test('FreezeHost 自动续期', async () => {
    let proxyConfig = process.env.GOST_PROXY ? { server: process.env.GOST_PROXY } : undefined;
    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();

    try {
        console.log('🔑 访问 FreezeHost...');
        await page.goto('https://free.freezehost.pro');
        await page.click('span.text-lg:has-text("Login with Discord")');
        await page.locator('button#confirm-login').waitFor();
        await page.click('button#confirm-login');

        console.log('✏️ 填写 Discord 账密...');
        await page.waitForURL(/discord\.com\/login/);
        await page.fill('input[name="email"]', DISCORD_EMAIL);
        await page.fill('input[name="password"]', DISCORD_PASSWORD);
        await page.click('button[type="submit"]');

        // 2FA 逻辑
        const twoFaInput = page.locator('input[autocomplete="one-time-code"]');
        if (await twoFaInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('🔐 触发 2FA，自动填写中...');
            const token = authenticator.generate(DISCORD_2FA.replace(/\s/g, ''));
            await twoFaInput.fill(token);
            await page.click('button[type="submit"]');
        }

        console.log('⏳ 处理授权与跳转...');
        await page.waitForTimeout(5000);
        const authBtn = page.locator('button:has-text("Authorize")');
        if (await authBtn.isVisible().catch(() => false)) await authBtn.click();

        await page.waitForURL(/free\.freezehost\.pro\/dashboard/, { timeout: 30000 });
        console.log('✅ 登录成功，进入控制台...');

        const serverUrl = await page.evaluate(() => document.querySelector('a[href*="server-console"]')?.href);
        await page.goto(serverUrl);
        
        await page.waitForTimeout(3000);
        await page.hover('i.fa-external-link-alt');
        await page.click('i.fa-external-link-alt', { force: true });
        
        const renewBtn = page.locator('#renew-link-modal');
        await renewBtn.waitFor({ state: 'visible' });
        
        if (!(await renewBtn.innerText()).toLowerCase().includes('renew instance')) {
            await sendTG('⏰ 尚未到续期时间');
            return;
        }

        const renewUrl = await renewBtn.getAttribute('href');
        await page.goto(new URL(renewUrl, page.url()).href);
        await page.waitForTimeout(5000);

        if (page.url().includes('success=RENEWED')) {
            await sendTG('✅ 续期成功！');
        } else {
            await sendTG('⚠️ 状态未知，请人工检查');
        }

    } catch (e) {
        await sendTG(`❌ 失败: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
