// Real renderer/preload/IPC pricing acceptance. All data and public HTML are local fixtures.
// No supplier inference requests, account keys, original configurations, or official tools.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const fixture = path.join(root, '.qa', 'pricing-ui', `run-${Date.now()}`);
assert.ok(fixture.startsWith(path.join(root, '.qa') + path.sep));
const reportsDir = path.join(root, 'artifacts', 'ui-review');
const screenshotsDir = path.join(root, 'docs', 'screenshots');
for (const folder of [fixture, reportsDir, screenshotsDir]) fs.mkdirSync(folder, { recursive: true });
const configPath = path.join(fixture, 'fixtures', 'codex', 'config.toml');
const claudeConfigPath = path.join(fixture, 'fixtures', 'claude', 'settings.json');
const stubPath = path.join(fixture, 'fixtures', 'fixture-cli.cmd');
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
const originalCodex = '# Disposable pricing acceptance\nmodel_provider = "openai"\n[features]\nfixture_feature = true\n';
const originalClaude = JSON.stringify({ env: { PRICING_ACCEPTANCE: 'local-only' } }, null, 2);
fs.writeFileSync(configPath, originalCodex);
fs.writeFileSync(claudeConfigPath, originalClaude);
fs.writeFileSync(stubPath, '@echo off\r\necho Workbench fixture CLI 0.0\r\n');
const ordinary = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const manualPrice = { currency: 'CNY', inputPerMillion: 0, outputPerMillion: 1.5, cacheReadPerMillion: .04, cacheWritePerMillion: .6, source: '本机验收 · 手动折扣价', updatedAt: '2026-10-11T03:00:00.000Z' };
const connections = [
  { id: 'flash-codex', name: '本机报价验收 · Codex', engine: 'codex', model: 'qwen3.8-flash', baseUrl: ordinary, presetId: 'custom', protocol: 'responses', hasKey: false },
  { id: 'flash-claude', name: '本机报价验收 · Claude', engine: 'claude', model: 'qwen3.8-flash', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', presetId: 'bailian-payg', protocol: 'anthropic', hasKey: false },
  { id: 'max-codex', name: '本机报价验收 · Max', engine: 'codex', model: 'qwen3.8-max', baseUrl: ordinary, presetId: 'bailian-payg', protocol: 'responses', hasKey: false },
  { id: 'manual-flash', name: '本机报价验收 · 手动价', engine: 'codex', model: 'qwen3.8-flash', baseUrl: ordinary, presetId: 'custom', protocol: 'responses', hasKey: false, pricing: manualPrice },
  { id: 'cleared-flash', name: '本机报价验收 · 已清空', engine: 'codex', model: 'qwen3.8-flash', baseUrl: ordinary, presetId: 'custom', protocol: 'responses', hasKey: false, pricingMode: 'manual' },
  { id: 'unsupported', name: '本机报价验收 · 其他模型', engine: 'codex', model: 'local-unknown-model', baseUrl: 'https://example.invalid/v1', presetId: 'custom', protocol: 'responses', hasKey: false },
];
fs.writeFileSync(path.join(fixture, 'workbench.json'), JSON.stringify({ version: 1, projects: [], connections, checkpoints: [], settings: { monthlyBudgetCNY: 100, autoFallback: false, codexPath: stubPath, codexDesktopPath: stubPath, claudePath: stubPath, codexConfigPath: configPath, claudeConfigPath, claudeLaunchDirectory: path.dirname(claudeConfigPath) } }, null, 2));
fs.writeFileSync(path.join(fixture, 'gateway.local.json'), JSON.stringify({ port: 53191, encryptedToken: '', routes: {} }));
const controlPath = path.join(fixture, 'public-price-fixture-control.json');
const fetchLogPath = path.join(fixture, 'public-price-fixture-fetch.jsonl');
const openedLogPath = path.join(fixture, 'opened-price-sources.jsonl');
const entryPath = path.join(fixture, 'isolated-electron-entry.cjs');
function control(mode = 'success', delayMs = 650) { fs.writeFileSync(controlPath, JSON.stringify({ mode, delayMs })); }
control();
// This test wrapper changes only this disposable process, not production code.
fs.writeFileSync(entryPath, `
const fs = require('node:fs');
const controlPath = ${JSON.stringify(controlPath)};
const fetchLogPath = ${JSON.stringify(fetchLogPath)};
const openedLogPath = ${JSON.stringify(openedLogPath)};
function fixtureHtml(model) {
  const rows = model === 'qwen3.8-flash' ? [['输入','0.9'],['输出','2.9'],['输入（缓存命中）','0.15'],['显式缓存创建','1.5'],['显式缓存命中','0.15']] : [['输入','13'],['输出','38'],['输入（缓存命中）','1.6'],['显式缓存创建','16'],['显式缓存命中','1.1']];
  const content = '<h2>模型价格</h2><section><h4>华北2（北京）</h4><table><thead><tr><th>计费项</th><th>价格（元）</th><th>单位</th></tr></thead><tbody>' + rows.map(row => '<tr><td>' + row[0] + '</td><td>' + row[1] + '</td><td>每百万tokens</td></tr>').join('') + '</tbody></table></section>';
  return '<script>window.__ICE_PAGE_PROPS__=' + JSON.stringify({docDetailData:{storeData:{data:{docTitle:model,content}}}}) + ';</script>';
}
globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  const mode = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
  const allowed = ['https://help.aliyun.com/zh/model-studio/qwen3-8-flash', 'https://help.aliyun.com/zh/model-studio/qwen3-8-max'];
  fs.appendFileSync(fetchLogPath, JSON.stringify({url:address,method:options.method,headers:options.headers,credentials:options.credentials,mode:mode.mode}) + String.fromCharCode(10));
  if (!allowed.includes(address)) throw new Error('Pricing UI acceptance blocked unexpected network request');
  await new Promise(resolve => setTimeout(resolve, mode.delayMs));
  if (mode.mode === 'failure') throw new Error('Local fixture: public documentation unavailable');
  const model = address.endsWith('qwen3-8-flash') ? 'qwen3.8-flash' : 'qwen3.8-max';
  return new Response(fixtureHtml(model), {status:200,headers:{'content-type':'text/html; charset=utf-8'}});
};
require('electron').shell.openExternal = async (url) => { fs.appendFileSync(openedLogPath, JSON.stringify({url}) + String.fromCharCode(10)); };
require(${JSON.stringify(path.join(root, 'dist', 'main', 'index.js'))});
`);
const report = { ok: false, version: '0.2.1', fixture, externalApiCalls: 0, actualApiKeysUsed: false, officialClientsLaunched: false, originalConfigFilesReadOrChanged: false, source: 'Real renderer/preload/IPC with local public documentation HTML fixtures; displayed rates are acceptance fixtures, not current official prices.', checks: [], screenshots: [], rendererErrors: [], startedAt: new Date().toISOString() };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const psQuote = value => `'${value.replace(/'/g, "''")}'`;
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
let ownedPid, browser, page;
function check(name) { report.checks.push(name); console.log(`PASS ${name}`); }
function jsonLines(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; }
async function requireUnusedPort(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}
async function launch() {
  await requireUnusedPort(9225); await requireUnusedPort(53191);
  const env = { ...process.env, WORKBENCH_TEST_DATA: fixture, WORKBENCH_UI_TEST: '1', WORKBENCH_DEBUG_PORT: '9225', NO_PROXY: '127.0.0.1,localhost' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.WORKBENCH_UI_VISIBLE;
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) delete env[key];
  const script = `$taskPricing = Start-Process -FilePath ${psQuote(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'))} -ArgumentList ${psQuote('"' + entryPath + '"')} -WorkingDirectory ${psQuote(root)} -WindowStyle Hidden -RedirectStandardError ${psQuote(path.join(fixture,'electron-stderr.log'))} -RedirectStandardOutput ${psQuote(path.join(fixture,'electron-stdout.log'))} -PassThru; $taskPricing.Id`;
  const launched = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { cwd: root, env, windowsHide: true, timeout: 10000 });
  ownedPid = Number(launched.stdout.trim()); assert.ok(Number.isInteger(ownedPid) && ownedPid > 0);
  let version;
  for (let attempt = 0; attempt < 100 && !version; attempt++) { try { version = await (await fetch('http://127.0.0.1:9225/json/version')).json(); } catch { await wait(200); } }
  assert.ok(version?.webSocketDebuggerUrl, 'isolated Electron pricing CDP ready; ' + (fs.existsSync(path.join(fixture,'electron-stderr.log')) ? fs.readFileSync(path.join(fixture,'electron-stderr.log'),'utf8').slice(0,1500) : 'no process diagnostics'));
  browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  for (let attempt = 0; attempt < 100 && !page; attempt++) { page = browser.contexts()[0].pages().find(candidate => candidate.url().startsWith('file:')); if (!page) await wait(100); }
  assert.ok(page); page.on('pageerror', error => report.rendererErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop));
  const state = await ipc('getState'); assert.equal(state.dataDir, fixture); assert.equal(state.companion.gateway.port, 53191);
  for (const tool of state.companion.tools) assert.ok(tool.configPath.startsWith(path.join(fixture, 'fixtures') + path.sep));
}
async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  if (ownedPid) await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${ownedPid} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`], { windowsHide: true, timeout: 10000 }).catch(() => {});
}
async function ipc(method, ...args) { return page.evaluate(({method,args}) => window.desktop[method](...args), {method,args}); }
async function until(predicate, message, attempts = 100) { for (let attempt = 0; attempt < attempts; attempt++) { if (await predicate()) return; await wait(100); } assert.fail(message); }
function row(id) { return page.locator(`.pricing-table tr[data-connection-id="${id}"]`); }
async function dismissToast() { const close = page.getByRole('button', {name:'关闭提示',exact:true}); if (await close.count()) await close.click(); }
async function finishUpdate() { await until(async () => await page.getByRole('button', {name:'更新官方价格',exact:true}).count() === 1 && await page.getByRole('button', {name:'更新官方价格',exact:true}).isEnabled(), 'official pricing update finished'); await dismissToast(); }
async function bulkUpdate() { await dismissToast(); await page.getByRole('button', {name:'更新官方价格',exact:true}).click(); await finishUpdate(); }
async function capture(filename, fullPage = false) { const output = path.join(screenshotsDir, filename); await page.screenshot({path:output,fullPage}); report.screenshots.push(output); }
async function run() {
  await launch();
  await page.locator('.nav-list').getByRole('button',{name:'用量与费用',exact:true}).click();
  await row('flash-codex').waitFor();
  let state = await ipc('getState');
  for (const id of ['flash-codex','flash-claude']) {
    const connection = state.connections.find(item => item.id === id);
    assert.equal(connection.pricing.inputPerMillion,.8); assert.equal(connection.pricing.cacheWritePerMillion,1.25); assert.equal(connection.pricing.sourceKind,'builtin');
    assert.ok(await row(id).getByText('官方 · 内置',{exact:true}).count());
    assert.equal(await row(id).locator('td').nth(4).textContent(),'¥1.25');
  }
  assert.equal(state.connections.find(item => item.id === 'manual-flash').pricing.inputPerMillion,0);
  assert.equal(state.connections.find(item => item.id === 'cleared-flash').pricing,undefined);
  assert.equal(jsonLines(fetchLogPath).length,0);
  assert.equal(await row('manual-flash').locator('td').nth(1).textContent(),'¥0');
  assert.equal(await row('max-codex').locator('td').nth(3).textContent(),'—');
  assert.ok((await row('max-codex').textContent()).includes('用量字段无法区分'));
  const quoteNote=await row('max-codex').locator('.price-quote-note').evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth,whiteSpace:getComputedStyle(element).whiteSpace}));
  assert.equal(quoteNote.whiteSpace,'normal'); assert.ok(quoteNote.scroll<=quoteNote.width,'long official scope/cache notes wrap inside their column');
  check('legacy Beijing Flash prices populated offline; manual and cleared values retained; Max ambiguity and cached-write rate visible');
  await capture('v2.1-pricing-builtin.png',true);

  await row('flash-codex').getByRole('button',{name:'查看来源',exact:true}).click();
  await until(() => jsonLines(openedLogPath).length === 1,'official source opened through real IPC');
  assert.equal(jsonLines(openedLogPath)[0].url,'https://help.aliyun.com/zh/model-studio/qwen3-8-flash');
  check('source link invokes real openExternal IPC using exact official document URL');

  await page.getByRole('button',{name:'更新官方价格',exact:true}).click();
  const updating = page.getByRole('button',{name:'正在更新…',exact:true});
  await updating.waitFor(); assert.equal(await updating.isEnabled(),false);
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent === '正在更新…')?.click());
  await finishUpdate();
  state = await ipc('getState');
  for (const id of ['flash-codex','flash-claude']) { const price=state.connections.find(item=>item.id===id).pricing; assert.equal(price.inputPerMillion,.9); assert.equal(price.outputPerMillion,2.9); assert.equal(price.cacheWritePerMillion,1.5); assert.equal(price.sourceKind,'network'); assert.ok(price.verifiedAt); }
  assert.equal(state.connections.find(item => item.id === 'manual-flash').pricing.inputPerMillion,0);
  assert.equal(state.connections.find(item => item.id === 'cleared-flash').pricing,undefined);
  const results = await page.locator('.price-update-report').textContent();
  for (const value of ['已更新 3','手动保留 2','未支持 1','保留手工单价','暂未支持']) assert.ok(results.includes(value),value);
  assert.equal(jsonLines(fetchLogPath).length,2,'one document read per supported model, no duplicate update');
  check('bulk online update locks repeated clicks, deduplicates documents and reports every success/manual skip/unsupported connection');
  await capture('v2.1-pricing-updated.png',true);

  const manualRow=row('manual-flash');
  await manualRow.getByRole('button',{name:'使用官方报价',exact:true}).click();
  const confirm=page.getByRole('dialog',{name:'使用官方报价',exact:true});
  await confirm.waitFor(); await page.keyboard.press('Escape'); await confirm.waitFor({state:'hidden'});
  assert.ok(await manualRow.getByRole('button',{name:'使用官方报价',exact:true}).evaluate(button=>button===document.activeElement));
  await manualRow.getByRole('button',{name:'使用官方报价',exact:true}).click();
  await confirm.getByRole('button',{name:'确认使用官方报价',exact:true}).click();
  await finishUpdate(); await confirm.waitFor({state:'hidden'});
  state=await ipc('getState');
  assert.equal(state.connections.find(item=>item.id==='manual-flash').pricingMode,'official');
  assert.equal(state.connections.find(item=>item.id==='manual-flash').pricing.inputPerMillion,.9);
  assert.ok(await manualRow.getByText('官方 · 联网',{exact:true}).count());
  check('manual quote switches to official after one confirmation; Escape restores keyboard focus');

  await row('flash-codex').getByRole('button',{name:'手动设置',exact:true}).click();
  const manualDialog=page.getByRole('dialog',{name:'设置连接单价',exact:true});
  await manualDialog.getByLabel('输入单价',{exact:true}).fill('0.45');
  await manualDialog.getByLabel('输出单价',{exact:true}).fill('1.4');
  await manualDialog.getByLabel('缓存写入（可选）',{exact:true}).fill('0.8');
  await manualDialog.getByLabel('价格来源 / 备注',{exact:true}).fill('本机验收 · 手动成交价');
  await manualDialog.getByRole('button',{name:'保存单价',exact:true}).click();
  await manualDialog.waitFor({state:'hidden'}); await dismissToast();
  assert.equal((await ipc('getState')).connections.find(item=>item.id==='flash-codex').pricingMode,'manual');
  await bulkUpdate();
  assert.equal((await ipc('getState')).connections.find(item=>item.id==='flash-codex').pricing.inputPerMillion,.45);
  check('editable manual prices including cached-write persist through bulk official refresh');

  await row('flash-codex').getByRole('button',{name:'手动设置',exact:true}).click();
  await manualDialog.getByRole('button',{name:'清除价格',exact:true}).click();
  await manualDialog.waitFor({state:'hidden'}); await dismissToast(); await bulkUpdate();
  assert.equal((await ipc('getState')).connections.find(item=>item.id==='flash-codex').pricing,undefined);
  assert.ok((await row('flash-codex').textContent()).includes('已停止自动跟随官方价'));
  await row('flash-codex').getByRole('button',{name:'使用官方报价',exact:true}).click();
  await confirm.getByRole('button',{name:'确认使用官方报价',exact:true}).click(); await finishUpdate();
  assert.equal((await ipc('getState')).connections.find(item=>item.id==='flash-codex').pricingMode,'official');
  check('cleared pricing is not silently repopulated and can resume official following without typing');

  state=await ipc('getState'); const before=state.connections.map(item=>({id:item.id,pricing:item.pricing,pricingMode:item.pricingMode}));
  control('failure',650); await bulkUpdate();
  const after=(await ipc('getState')).connections.map(item=>({id:item.id,pricing:item.pricing,pricingMode:item.pricingMode}));
  assert.deepEqual(after,before); assert.ok((await page.locator('.price-update-report').textContent()).includes('失败 4')); assert.ok((await page.locator('.price-update-report').textContent()).includes('保留原单价'));
  check('public documentation fetch failures show per-connection errors and preserve all prior quote metadata');
  await capture('v2.1-pricing-failure.png',true);

  control('success',1100);
  await page.getByRole('button',{name:'更新官方价格',exact:true}).click();
  await page.getByRole('button',{name:'正在更新…',exact:true}).waitFor();
  await ipc('savePricing',{connectionId:'flash-codex',pricing:{currency:'CNY',inputPerMillion:.22,outputPerMillion:.66,source:'本机验收 · 并发手动编辑'}});
  await finishUpdate();
  assert.equal((await ipc('getState')).connections.find(item=>item.id==='flash-codex').pricing.inputPerMillion,.22);
  assert.ok((await page.locator('.price-update-report').textContent()).includes('配置已变更'));
  check('in-flight official refresh preserves a newer manual edit and reports changed-skipped');

  for (const width of [940,680]) {
    await page.setViewportSize({width,height:800});
    await row('max-codex').scrollIntoViewIfNeeded();
    const geometry=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));
    assert.ok(geometry.width<=geometry.viewport,`${width}px viewport has no document overflow`);
    await row('max-codex').getByRole('button',{name:'手动设置',exact:true}).click();
    const box=await manualDialog.boundingBox(); assert.ok(box.x>=0&&box.x+box.width<=width);
    await page.keyboard.press('Escape'); await manualDialog.waitFor({state:'hidden'});
    await row('max-codex').getByRole('button',{name:'查看来源',exact:true}).click(); await dismissToast();
  }
  check('940px/680px layouts keep four rates, provenance and dialogs accessible without document overflow');
  await capture('v2.1-pricing-small.png',true);
  await page.setViewportSize({width:1320,height:880});
  await page.getByRole('button',{name:'收起价格更新结果',exact:true}).click();
  await page.locator('.page-heading').scrollIntoViewIfNeeded(); await capture('v2.1-usage.png',true);

  assert.equal(fs.readFileSync(configPath,'utf8'),originalCodex); assert.equal(fs.readFileSync(claudeConfigPath,'utf8'),originalClaude);
  assert.equal((await ipc('getUsageRecords')).length,0);
  const fetches=jsonLines(fetchLogPath);
  for(const fetch of fetches){assert.match(fetch.url,/^https:\/\/help\.aliyun\.com\/zh\/model-studio\/qwen3-8-(?:flash|max)$/);assert.equal(fetch.method,'GET');assert.equal(fetch.credentials,'omit');assert.deepEqual(fetch.headers,{Accept:'text/html'});}
  assert.deepEqual(report.rendererErrors,[]);
  report.mockedPublicDocumentFetches=fetches.length;
  check('all document lookups contain no secrets; no inference/use ledger records; fixture tool configs unchanged; no renderer errors');
  report.ok=true;
}
run().catch(error=>{report.error=error.stack||String(error);console.error(report.error);process.exitCode=1;}).finally(async()=>{await cleanup();report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(reportsDir,'smoke-pricing-ui-report.json'),JSON.stringify(report,null,2));console.log(`REPORT ${path.join(reportsDir,'smoke-pricing-ui-report.json')}`);});
