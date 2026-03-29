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
            // 1. 清理 iframe 广告
            document.querySelectorAll('iframe').forEach(iframe => {
                if (iframe.id.includes('google') || iframe.src.includes('ads') || iframe.id.includes('vignette') || iframe.name.includes('google')) {
                    iframe.remove();
                }
            });
            // 2. 💡 核心新增：直接粉碎 fc-dialog-overlay 这类阻挡点击的遮罩层
            document.querySelectorAll('.fc-dialog-overlay, .fc-message-root, [class*="overlay"], [class*="backdrop"]').forEach(el => el.remove());
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

// 📨 发送 TG 消息 (直接发送拼装好的完整内容)
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

            const twoFaInput = page.locator('input[autocomplete="one-time-code"], input[placeholder*="6"], input[maxlength="6"]');
            
            await twoFaInput.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
            
            if (await twoFaInput.isVisible()) {
                if (!twoFaSecret) throw new Error("❌ 触发了 2FA，但未配置该账号的 2FA 秘钥 (格式: 账号,密码,秘钥)");
                console.log('🔐 发现 2FA 页面，正在自动计算并填写...');
                const token = authenticator.generate(twoFaSecret.replace(/\s/g, ''));
                await twoFaInput.fill(token);
                await page.waitForTimeout(500); 
                await page.click('button[type="submit"]');
                await page.waitForTimeout(4000); 
            }

            await page.waitForTimeout(5000);
            const authBtn = page.locator('button:has-text("Authorize"), button:has-text("授权")');
            if (await authBtn.isVisible().catch(() => false)) await authBtn.click();

            await page.waitForURL(/free\.freezehost\.pro\/dashboard/, { timeout: 30000 });
            console.log('✅ 登录成功！');
            await page.waitForTimeout(4000);

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
                        
                        // 弹窗出来后，再次执行物理清场
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
