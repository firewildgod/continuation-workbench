// Manual packaged UI check. Only activates the installed Codex window.
// Fixture data stays in .qa; no client settings or inference prompts are changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  let version;
  for (let attempt = 0; attempt < 40 && !version; attempt++) {
    try { version = await (await fetch('http://127.0.0.1:9223/json/version')).json(); }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  assert.ok(version, 'packaged test browser becomes ready');
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  try {
    let page;
    for (let attempt = 0; attempt < 80 && !page; attempt++) {
      page = browser.contexts()[0].pages().find(p => p.url().startsWith('file:'));
      if (!page) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(page, 'packaged renderer exists');
    const rendererErrors = [];
    page.on('pageerror', error => rendererErrors.push(error.message));
    await page.waitForFunction(() => Boolean(window.desktop));
    await page.getByRole('button', { name: '切换到 Codex', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开 Claude Code 终端', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '打开终端', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '切回工作台', exact: true }).count(), 1);
    await page.getByRole('button', { name: '切换到 Codex', exact: true }).click();
    await page.locator('.toast').filter({ hasText: '已切回正在运行的 Codex 工作台' }).waitFor({ timeout: 30000 });
    const state = await page.evaluate(() => window.desktop.getState());
    assert.equal(state.presets.length, 9);
    assert.equal(state.companion.tools.find(t => t.engine === 'codex').running, true);
    assert.ok(await page.getByText('v0.1.1', { exact: true }).count());
    const screenshot = path.join(root, 'docs/screenshots/06-launch-repair.png');
    await page.screenshot({ path: screenshot });
    assert.deepEqual(rendererErrors, []);
    const report = {
      version: '0.1.1', sidebarButtons: true, cardButtons: true,
      realCodexActivationViaIPC: true, rendererErrors, screenshot,
      message: await page.locator('.toast span').first().textContent(),
    };
    fs.writeFileSync(path.join(root, '.qa/launch-repair-ui/result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
