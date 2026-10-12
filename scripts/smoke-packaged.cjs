/* Final portable artifact check. QA-owned state; public pricing docs only, no model calls. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const artifact = path.join(root, 'release', `Continuation-Workbench-${version}-portable.exe`);
const qaDir = path.join(root, '.qa', `v0.2-packaged-${Date.now()}`);
const debugPort = 9225;
const gatewayPort = 53191;
const report = { pass: false, artifact: path.basename(artifact), checks: [], externalApiCalls: 0 };
let child, browser, ownedBrowserPid;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function main() {
  assert.ok(fs.existsSync(artifact), 'Portable artifact missing');
  const contents = asar.listPackage(path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar'));
  assert.equal(contents.some(name => /(?:^|[\\/])(?:data|\.qa)(?:[\\/]|$)|api-secrets\.local\.json|usage-ledger|gateway\.local\.json|workbench\.json/.test(name)), false, 'Private state packaged');
  const metadata = JSON.parse(asar.extractFile(path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar'), 'package.json').toString());
  assert.equal(metadata.version, version);
  const packagedHtml = asar.extractFile(path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar'), path.join('dist', 'renderer', 'index.html'));
  assert.deepEqual(packagedHtml, fs.readFileSync(path.join(root, 'dist', 'renderer', 'index.html')), 'Packaged renderer does not match final build');
  assert.ok(contents.some(name => name.replace(/\\/g, '/').endsWith('assets/app-icon.ico')));
  report.checks.push('ASAR version and private-state exclusion');
  // Refuse to attach to an existing debugging endpoint.
  const occupied = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(() => true, () => false);
  assert.equal(occupied, false, 'QA debugging port already occupied');
  fs.mkdirSync(qaDir, { recursive: true });
  const codexConfigPath = path.join(qaDir, 'fixtures', 'codex', 'config.toml');
  const claudeConfigPath = path.join(qaDir, 'fixtures', 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
  fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
  fs.writeFileSync(codexConfigPath, 'model_provider = "openai"\n');
  fs.writeFileSync(claudeConfigPath, '{}');
  fs.writeFileSync(path.join(qaDir, 'workbench.json'), JSON.stringify({ version: 1, projects: [], connections: [], checkpoints: [], settings: { codexConfigPath, claudeConfigPath } }));
  fs.writeFileSync(path.join(qaDir, 'gateway.local.json'), JSON.stringify({ port: gatewayPort, encryptedToken: '', routes: {} }));
  child = spawn(artifact, [], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, WORKBENCH_TEST_DATA: qaDir, WORKBENCH_UI_TEST: '1', WORKBENCH_DEBUG_PORT: String(debugPort), WORKBENCH_GATEWAY_PORT: String(gatewayPort), WORKBENCH_UI_VISIBLE: '0' },
  });
  child.on('error', () => { report.launchError = true; });
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt++) {
    endpoint = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(result => result.json(), () => null);
    if (endpoint?.webSocketDebuggerUrl) break;
    await delay(500);
  }
  assert.ok(endpoint?.webSocketDebuggerUrl, 'Portable did not expose isolated QA page');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  let page;
  for (let attempt = 0; attempt < 80; attempt++) {
    page = browser.contexts()[0]?.pages().find(item => item.url().startsWith('file:'));
    if (page) break;
    await delay(500);
  }
  assert.ok(page, 'Renderer missing');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop));
  const state = await page.evaluate(() => window.desktop.getState());
  assert.equal(path.resolve(state.dataDir).toLowerCase(), qaDir.toLowerCase());
  ownedBrowserPid = Number(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$qaListener = Get-NetTCPConnection -LocalPort 9225 -State Listen -ErrorAction Stop | Select-Object -First 1; $qaProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $qaListener.OwningProcess); if ([IO.Path]::GetFileName($qaProcess.ExecutablePath) -ne '续航台.exe' -or $qaProcess.CommandLine -match '--type=') { throw 'Packaged QA executable guard failed' }; $qaProcess.ProcessId"], { encoding: 'utf8', windowsHide: true }).trim());
  assert.ok(Number.isSafeInteger(ownedBrowserPid) && ownedBrowserPid > 0);
  assert.equal(state.connections.length, 0);
  assert.equal(state.companion.gateway.running, true);
  assert.equal(state.companion.gateway.port, gatewayPort);
  const summary = await page.evaluate(() => window.desktop.getUsageSummary());
  assert.equal(summary.today.requestCount, 0);
  assert.equal(summary.month.requestCount, 0);
  const priceConnection = await page.evaluate(() => window.desktop.saveConnection({ name: '打包价格验收 · 无密钥', presetId: 'bailian-payg', engine: 'codex', protocol: 'responses', model: 'qwen3.8-flash', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }));
  assert.equal(priceConnection.hasKey, false);
  assert.equal(priceConnection.pricing.sourceKind, 'builtin');
  assert.equal(priceConnection.pricing.inputPerMillion, 0.8);
  const priceReport = await page.evaluate(id => window.desktop.refreshOfficialPricing({ connectionIds: [id] }), priceConnection.id);
  assert.equal(priceReport.updatedCount, 1, 'Actual packaged official price refresh failed');
  assert.equal(priceReport.results[0].pricing.sourceKind, 'network');
  assert.equal(priceReport.results[0].pricing.sourceUrl, 'https://help.aliyun.com/zh/model-studio/qwen3-8-flash');
  assert.equal((await page.evaluate(() => window.desktop.getUsageSummary())).month.requestCount, 0);
  report.checks.push('Built-in price without an API key', 'Real public official price refresh via packaged IPC', 'Price refresh creates no model usage');
  report.publicDocumentationLookups = 1;
  const guiConnection = await page.evaluate(() => window.desktop.saveConnection({ name: '打包桌面验收 · 离线假密钥', presetId: 'anthropic', engine: 'claude', protocol: 'anthropic', model: 'claude-sonnet-4-6', baseUrl: 'https://packaged-fixture.invalid', apiKey: 'packaged-fixture-key-never-sent' }));
  const gui = await page.evaluate(() => window.desktop.getClaudeDesktopState());
  assert.ok(path.resolve(gui.configPath).toLowerCase().startsWith(qaDir.toLowerCase() + path.sep));
  const guiPreview = await page.evaluate(id => window.desktop.previewClaudeDesktopConfig({ mode: 'api', connectionId: id }), guiConnection.id);
  assert.equal(guiPreview.surface, 'desktop');
  assert.equal(guiPreview.activationKind, 'auto');
  assert.ok(guiPreview.after.includes('/claude-desktop'));
  assert.equal(guiPreview.after.includes('packaged-fixture-key-never-sent'), false);
  assert.equal(fs.existsSync(gui.configPath), false, 'A desktop preview must not write configuration');
  assert.equal((await page.evaluate(() => window.desktop.getUsageSummary())).month.requestCount, 0);
  report.checks.push('Independent Claude Desktop IPC and read-only redacted preview');
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('heading', { name: 'Claude Desktop', exact: true }).waitFor();
  report.checks.push('Packaged graphical desktop configuration card');
  await page.getByRole('button', { name: '用量与费用', exact: true }).click();
  await page.getByRole('button', { name: 'API 连接', exact: true }).click();
  await page.getByLabel('供应商 / 计费方式').selectOption('bailian-payg');
  await page.getByLabel('使用工具').selectOption('claude');
  await page.getByLabel('服务地址（Base URL）').waitFor();
  assert.equal(await page.getByLabel('服务地址（Base URL）').inputValue(), 'https://dashscope.aliyuncs.com/apps/anthropic');
  assert.deepEqual(errors, []);
  report.checks.push('Actual portable extraction and startup', 'Renderer and preload IPC', 'Isolated local gateway', 'Empty usage state', 'Tool-specific provider URL', 'No renderer errors');
  report.pass = true;
}
main().catch(error => { report.failure = error.message; }).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  for (const pid of new Set([ownedBrowserPid, child?.pid])) if (Number.isSafeInteger(pid) && pid > 0) {
    // Only the launcher we created and browser PID from its verified QA app.
    try { execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
  fs.mkdirSync(qaDir, { recursive: true });
  fs.writeFileSync(path.join(qaDir, 'packaged-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report));
  process.exitCode = report.pass ? 0 : 1;
});
