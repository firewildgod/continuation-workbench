// End-to-end smoke test of this application's real renderer, preload and IPC.
// All configuration, keys, inference and spend belong to disposable local fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const TOML = require('@iarna/toml');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const qaRoot = path.join(root, '.qa', 'v0.2-smoke');
const fixture = path.join(qaRoot, `run-${Date.now()}`);
assert.ok(fixture.startsWith(path.join(root, '.qa') + path.sep));
const reportsDir = path.join(root, 'artifacts', 'ui-review');
const screenshotsDir = path.join(root, 'docs', 'screenshots');
for (const folder of [fixture, reportsDir, screenshotsDir]) fs.mkdirSync(folder, { recursive: true });
const configPath = path.join(fixture, 'fixtures', 'codex', 'config.toml');
const claudeConfigPath = path.join(fixture, 'fixtures', 'claude', 'settings.json');
const stubPath = path.join(fixture, 'fixtures', 'fixture-cli.cmd');
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
const originalCodex = '# Disposable local smoke configuration\nmodel_provider = "openai"\n[features]\nfixture_feature = true\n';
const originalClaude = JSON.stringify({ permissions: { allow: [] }, env: { WORKBENCH_LOCAL_SMOKE: 'preserve-me' } }, null, 2) + '\n';
fs.writeFileSync(configPath, originalCodex);
fs.writeFileSync(claudeConfigPath, originalClaude);
fs.writeFileSync(stubPath, '@echo off\r\necho Workbench fixture CLI 0.0\r\n');
fs.writeFileSync(path.join(fixture, 'workbench.json'), JSON.stringify({ version: 1, projects: [], connections: [], checkpoints: [], settings: { monthlyBudgetCNY: 100, autoFallback: false, codexPath: stubPath, codexDesktopPath: stubPath, claudePath: stubPath, codexConfigPath: configPath, claudeConfigPath, claudeLaunchDirectory: path.dirname(claudeConfigPath) } }, null, 2));
fs.writeFileSync(path.join(fixture, 'gateway.local.json'), JSON.stringify({ port: 53190, encryptedToken: '', routes: {} }));
const report = { ok: false, version: '0.2.0', fixture, externalApiCalls: 0, actualApiKeysUsed: false, officialClientsLaunched: false, originalConfigFilesReadOrChanged: false, source: 'Real application IPC with local mock inference; these amounts are test estimates, not supplier invoices.', checks: [], screenshots: [], rendererErrors: [], startedAt: new Date().toISOString() };
const fakeCodexKey = 'local-smoke-only-codex-key-00000001';
const fakeClaudeKey = 'local-smoke-only-claude-key-00000002';
const fakeLegacyKey = 'local-smoke-only-legacy-key-00000003';
let ownedPid, browser, page, upstream, upstreamBase;
const received = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const psQuote = value => `'${value.replace(/'/g, "''")}'`;
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function check(name) { report.checks.push(name); console.log(`PASS ${name}`); }
async function requireUnusedPort(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}
async function launchOwnApplication() {
  await requireUnusedPort(9224); await requireUnusedPort(53190);
  const env = { ...process.env, WORKBENCH_TEST_DATA: fixture, WORKBENCH_UI_TEST: '1', WORKBENCH_DEBUG_PORT: '9224', NO_PROXY: '127.0.0.1,localhost' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WORKBENCH_UI_VISIBLE;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  const script = `$taskSmoke = Start-Process -FilePath ${psQuote(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'))} -ArgumentList '.' -WorkingDirectory ${psQuote(root)} -WindowStyle Hidden -PassThru; $taskSmoke.Id`;
  const launched = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { cwd: root, env, windowsHide: true, timeout: 10000 });
  ownedPid = Number(launched.stdout.trim()); assert.ok(Number.isInteger(ownedPid) && ownedPid > 0);
  let version;
  for (let attempt = 0; attempt < 80 && !version; attempt++) {
    try { version = await (await fetch('http://127.0.0.1:9224/json/version')).json(); } catch { await wait(250); }
  }
  assert.ok(version?.webSocketDebuggerUrl, 'isolated Electron CDP ready');
  browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  for (let attempt = 0; attempt < 80 && !page; attempt++) {
    page = browser.contexts()[0].pages().find(candidate => candidate.url().startsWith('file:'));
    if (!page) await wait(150);
  }
  assert.ok(page);
  page.on('pageerror', error => report.rendererErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop), { timeout: 20000 });
  const state = await ipc('getState');
  assert.equal(state.dataDir, fixture);
  for (const tool of state.companion.tools) assert.ok(tool.configPath.startsWith(path.join(fixture, 'fixtures') + path.sep), 'every tool config stays inside fixtures');
  assert.equal(state.companion.gateway.port, 53190);
  assert.equal(state.companion.gateway.running, true);
}
async function stopOwnApplication() {
  if (browser) { await browser.close().catch(() => {}); browser = undefined; page = undefined; }
  if (ownedPid) {
    await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${ownedPid} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`], { windowsHide: true, timeout: 10000 });
    ownedPid = undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await requireUnusedPort(53190); await requireUnusedPort(9224); break; } catch { await wait(100); }
    }
  }
}
async function ipc(method, ...args) {
  return page.evaluate(({ method, args }) => window.desktop[method](...args), { method, args });
}
async function until(predicate, message, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt++) { if (await predicate()) return; await wait(100); }
  assert.fail(message);
}
async function closeToast() { const close = page.getByRole('button', { name: '关闭提示', exact: true }); if (await close.count()) await close.click(); }
async function navigate(label) { await closeToast(); await page.locator('.nav-list').getByRole('button', { name: label, exact: true }).click(); }
async function refreshRenderer() {
  await closeToast();
  const refresh = page.locator('.topbar-actions').getByRole('button', { name: '刷新状态', exact: true });
  await refresh.click();
  const state = await ipc('getState');
  const summary = await ipc('getUsageSummary');
  await until(async () => {
    const count = await page.locator('.nav-count').textContent();
    const values = await page.locator('.metric-value').allTextContents();
    return await refresh.isEnabled() && count === String(state.connections.length) && (!values.length || values[2] === String(summary.month.requestCount));
  }, 'renderer refresh completes with current connection and usage counts');
  await closeToast();
}
async function capture(filename, fullPage = false) {
  const output = path.join(screenshotsDir, filename); await page.screenshot({ path: output, fullPage }); report.screenshots.push(output);
}
async function assertControl(label, expected) { assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), expected); }
async function waitConnection(name) {
  await until(async () => (await ipc('getState')).connections.some(connection => connection.name === name), `connection ${name} saved`);
  return (await ipc('getState')).connections.find(connection => connection.name === name);
}
async function startMockUpstream() {
  upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const anthropic = request.url.includes('/messages');
    received.push({ path: request.url, auth: request.headers.authorization, key: request.headers['x-api-key'], model: body.model, stream: !!body.stream });
    const mode = body.input || body.messages?.[0]?.content;
    if (mode === 'error') { response.writeHead(429, { 'content-type': 'application/json' }); return response.end('{"error":{"message":"Local smoke rate limit"}}'); }
    if (body.stream && anthropic) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { model: body.model, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 } } }) + '\n\n');
      response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"LOCAL_SMOKE_RESPONSE_TEXT"}}\n\n');
      return response.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":20}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    }
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"LOCAL_SMOKE_RESPONSE_TEXT"}\n\n');
      return response.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { model: body.model, status: 'completed', usage: { input_tokens: 1000000, output_tokens: 100000, input_tokens_details: { cached_tokens: 800000 } } } }) + '\n\ndata: [DONE]\n\n');
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    const diagnostic = mode === 'Reply with OK.';
    const usage = mode === 'unknown' ? undefined : anthropic ? { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 100 } : diagnostic ? { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 60 } } : { input_tokens: 1200, output_tokens: 300, input_tokens_details: { cached_tokens: 700 } };
    response.end(JSON.stringify(anthropic ? { type: 'message', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'LOCAL_SMOKE_RESPONSE_TEXT' }], usage } : { object: 'response', model: body.model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'LOCAL_SMOKE_RESPONSE_TEXT' }] }], usage }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
}
async function relay(engine, body) {
  const config = engine === 'codex' ? TOML.parse(fs.readFileSync(configPath, 'utf8')).model_providers.continuation_workbench : JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8')).env;
  const url = engine === 'codex' ? config.base_url + '/responses' : config.ANTHROPIC_BASE_URL + '/v1/messages?beta=true';
  const headers = engine === 'codex' ? config.http_headers : { Authorization: `Bearer ${config.ANTHROPIC_AUTH_TOKEN}`, 'anthropic-beta': 'local-smoke-tools' };
  const response = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() };
}
async function run() {
  await startMockUpstream();
  await launchOwnApplication();
  check('isolated Electron renderer and real preload IPC; only fixture configs');
  // Generate a legitimately encrypted fake key, then restart only our process
  // with a legacy bad URL fixture to test repair without losing that key.
  const legacy = await ipc('saveConnection', { name: '本机验收 · 旧错误地址', engine: 'claude', presetId: 'custom', protocol: 'anthropic', model: 'qwen3.8-flash', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', apiKey: fakeLegacyKey });
  assert.equal(legacy.hasKey, true);
  await until(() => {
    const localState = path.join(fixture, 'electron', 'session', 'Local State');
    try { return !!JSON.parse(fs.readFileSync(localState, 'utf8')).os_crypt?.encrypted_key; } catch { return false; }
  }, 'Chromium encryption master key reaches the fixture disk before restart', 400);
  await stopOwnApplication();
  const savedFile = path.join(fixture, 'workbench.json');
  const saved = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
  const legacyFixture = saved.connections.find(connection => connection.id === legacy.id);
  legacyFixture.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'; legacyFixture.testStatus = 'failed'; legacyFixture.testMessage = 'HTTP 404: local legacy configuration fixture'; delete legacyFixture.pricing;
  fs.writeFileSync(savedFile, JSON.stringify(saved, null, 2));
  await launchOwnApplication();
  await navigate('API 连接');
  await page.locator('.connection-card').filter({ hasText: '本机验收 · 旧错误地址' }).click();
  await page.getByRole('button', { name: '修正接口地址', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存并测试', exact: true }).isEnabled(), false);
  await page.getByRole('button', { name: '修正接口地址', exact: true }).click();
  await assertControl('服务地址（Base URL）', 'https://dashscope.aliyuncs.com/apps/anthropic');
  await assertControl('API Key', '');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await until(async () => (await ipc('getState')).connections.find(connection => connection.id === legacy.id)?.baseUrl.endsWith('/apps/anthropic'), 'legacy repair saved');
  assert.equal((await ipc('getState')).connections.find(connection => connection.id === legacy.id).hasKey, true);
  check('legacy Claude wrong URL blocked and one-click repair keeps encrypted fake key');
  await closeToast(); await page.getByRole('button', { name: '新增连接', exact: true }).click();
  await page.getByLabel('供应商 / 计费方式', { exact: true }).selectOption('bailian-payg');
  await assertControl('服务地址（Base URL）', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  await assertControl('模型 ID', 'qwen3.8-flash');
  await page.getByLabel('使用工具', { exact: true }).selectOption('claude');
  await assertControl('服务地址（Base URL）', 'https://dashscope.aliyuncs.com/apps/anthropic');
  assert.ok(await page.getByText('Anthropic Messages · Claude Code', { exact: true }).count());
  await page.getByLabel('使用工具', { exact: true }).selectOption('codex');
  await assertControl('服务地址（Base URL）', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  check('pay-as-you-go preset automatically switches URL and protocol per tool');
  await page.getByLabel('供应商 / 计费方式', { exact: true }).selectOption('custom');
  await page.getByLabel('连接名称', { exact: true }).fill('本机验收 · Codex');
  await page.getByLabel('模型 ID', { exact: true }).fill('fixture-codex-manual');
  await page.getByLabel('API Key', { exact: true }).fill(fakeCodexKey);
  await page.getByLabel('服务地址（Base URL）', { exact: true }).fill(upstreamBase + '/v1');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const codex = await waitConnection('本机验收 · Codex'); assert.equal(codex.model, 'fixture-codex-manual'); assert.equal(codex.hasKey, true);
  check('renderer form saves a manually selected model with encrypted local fake key');
  await navigate('用量与费用');
  await page.locator('tr').filter({ hasText: '本机验收 · Codex' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('输入单价', { exact: true }).fill('.8');
  await page.getByLabel('输出单价', { exact: true }).fill('2.7');
  await page.getByLabel('缓存读取（可选）', { exact: true }).fill('.1');
  await page.getByLabel('缓存写入（可选）', { exact: true }).fill('1.25');
  await page.getByLabel('价格来源 / 备注', { exact: true }).fill('本机 mock 验收价，非供应商账单');
  await page.getByRole('button', { name: '保存单价', exact: true }).click();
  await page.getByRole('dialog', { name: '设置连接单价' }).waitFor({ state: 'hidden' });
  assert.equal((await ipc('getState')).connections.find(connection => connection.id === codex.id).pricing.cacheWritePerMillion, 1.25);
  check('price modal saves all four numeric rates through real IPC');
  await navigate('API 连接');
  await page.locator('.connection-card').filter({ hasText: '本机验收 · Codex' }).click();
  await page.getByRole('button', { name: '保存并测试', exact: true }).click();
  await until(async () => (await ipc('getUsageRecords')).length === 1, 'connection diagnostic ledger recorded');
  const diagnostic = (await ipc('getUsageRecords'))[0]; assert.equal(diagnostic.kind, 'connection-test'); assert.equal(diagnostic.outcome, 'success'); assert.ok(Math.abs(diagnostic.costCNY - .000065) < 1e-10);
  check('small real connection-test request to local mock is included in ledger');
  await page.getByLabel('模型 ID', { exact: true }).fill('fixture-dirty');
  await page.getByText('配置已修改，请保存并重新测试。', { exact: true }).waitFor();
  assert.equal(await page.locator('.test-result').count(), 0);
  await page.getByLabel('模型 ID', { exact: true }).fill('fixture-codex-manual');
  check('editing model invalidates stale validation result');
  await navigate('工作台');
  const codexCard = page.locator('.connector-card').filter({ hasText: '官方桌面应用' });
  await codexCard.getByLabel('使用方式', { exact: true }).selectOption('api');
  await codexCard.getByLabel('API 连接', { exact: true }).selectOption(codex.id);
  await codexCard.getByRole('button', { name: '预览并应用', exact: true }).click();
  await page.getByRole('dialog', { name: '配置预览' }).waitFor();
  assert.equal(fs.readFileSync(configPath, 'utf8'), originalCodex, 'preview is read-only');
  assert.ok(!(await page.locator('.drawer').textContent()).includes(fakeCodexKey));
  await page.getByRole('button', { name: '应用这份配置并保存备份', exact: true }).click();
  await page.getByRole('dialog', { name: '配置预览' }).waitFor({ state: 'hidden' });
  assert.equal(TOML.parse(fs.readFileSync(configPath, 'utf8')).features.fixture_feature, true);
  check('real Codex config preview/apply writes fixture only and keeps original settings');
  const codexJSON = await relay('codex', { model: 'alias-ignored', input: 'LOCAL_SMOKE_PROMPT', stream: false }); assert.equal(codexJSON.status, 200); assert.equal(received.at(-1).model, codex.model); assert.equal(received.at(-1).auth, `Bearer ${fakeCodexKey}`);
  const codexSSE = await relay('codex', { model: 'alias-ignored', input: 'LOCAL_SMOKE_PROMPT', stream: true }); assert.match(codexSSE.contentType, /event-stream/); assert.match(codexSSE.text, /\[DONE\]/);
  await relay('codex', { model: 'alias-ignored', input: 'unknown', stream: false });
  check('Codex JSON and SSE traverse gateway and normalize cached input metadata');
  const claude = await ipc('saveConnection', { name: '本机验收 · Claude Code', presetId: 'custom', engine: 'claude', baseUrl: upstreamBase + '/anthropic', protocol: 'anthropic', model: 'fixture-claude', apiKey: fakeClaudeKey });
  await ipc('savePricing', { connectionId: claude.id, pricing: { currency: 'CNY', inputPerMillion: 4, outputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 5, source: '本机 mock 验收价，非供应商账单' } });
  await refreshRenderer();
  const claudeCard = page.locator('.connector-card').filter({ hasText: '终端 · CLI 配置' });
  await claudeCard.getByLabel('使用方式', { exact: true }).selectOption('api');
  await claudeCard.getByLabel('API 连接', { exact: true }).selectOption(claude.id);
  await claudeCard.getByRole('button', { name: '预览并应用', exact: true }).click();
  await page.getByRole('dialog', { name: '配置预览' }).waitFor();
  assert.ok(!(await page.locator('.drawer').textContent()).includes(fakeClaudeKey));
  await page.getByRole('button', { name: '应用这份配置并保存备份', exact: true }).click();
  await page.getByRole('dialog', { name: '配置预览' }).waitFor({ state: 'hidden' });
  assert.equal(JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8')).env.WORKBENCH_LOCAL_SMOKE, 'preserve-me');
  const claudeJSON = await relay('claude', { model: 'claude-alias-ignored', messages: [{ role: 'user', content: 'LOCAL_SMOKE_PROMPT' }], stream: false }); assert.equal(claudeJSON.status, 200); assert.equal(received.at(-1).key, fakeClaudeKey); assert.equal(received.at(-1).path, '/anthropic/v1/messages?beta=true');
  const claudeSSE = await relay('claude', { model: 'claude-alias-ignored', messages: [{ role: 'user', content: 'LOCAL_SMOKE_PROMPT' }], stream: true }); assert.match(claudeSSE.text, /message_stop/);
  assert.equal((await relay('claude', { model: 'ignored', messages: [{ role: 'user', content: 'error' }] })).status, 429);
  check('Claude fixture config and JSON/SSE forwarding preserve cache read/write and beta path');
  const unpriced = await ipc('saveConnection', { name: '本机验收 · 未定价', presetId: 'custom', engine: 'codex', protocol: 'responses', baseUrl: upstreamBase + '/v1', model: 'fixture-unpriced', apiKey: fakeCodexKey });
  await ipc('switchRoute', { engine: 'codex', connectionId: unpriced.id });
  await relay('codex', { model: 'ignored', input: 'LOCAL_SMOKE_PROMPT', stream: false });
  await until(async () => (await ipc('getUsageRecords')).length === 8, 'all eight calls recorded');
  const rows = await ipc('getUsageRecords');
  assert.equal(rows.filter(row => row.costCNY === null).length, 3);
  assert.equal(rows.filter(row => row.tokens === null).length, 2);
  assert.ok(rows.some(row => row.tokens?.cacheWriteTokens === 100 && row.tokens?.inputTokens === 450 && Math.abs(row.costCNY - .0012) < 1e-10));
  assert.ok(rows.some(row => row.tokens?.cacheReadTokens === 800000 && Math.abs(row.costCNY - .51) < 1e-10));
  const summary = await ipc('getUsageSummary');
  assert.equal(summary.today.requestCount, 8); assert.equal(summary.month.requestCount, 8); assert.equal(summary.today.costCNY, null); assert.equal(summary.today.unpricedRequests, 3); assert.equal(summary.today.unknownUsageRequests, 2);
  assert.ok(Math.abs(summary.today.knownCostCNY - .513545) < 1e-10);
  report.usage = { requests: 8, knownCostCNY: summary.today.knownCostCNY, unpriced: 3, unknownUsage: 2, normalizedCacheRead: summary.today.cacheReadTokens };
  check('ledger distinguishes known price, missing price, missing usage and HTTP failure');
  await until(() => fs.existsSync(path.join(fixture, 'usage-ledger.jsonl')) && fs.readFileSync(path.join(fixture, 'usage-ledger.jsonl'), 'utf8').trim().split('\n').length === 8, 'ledger append flushed');
  const ledgerText = fs.readFileSync(path.join(fixture, 'usage-ledger.jsonl'), 'utf8');
  assert.doesNotMatch(ledgerText, /LOCAL_SMOKE_PROMPT|LOCAL_SMOKE_RESPONSE_TEXT|local-smoke-only/);
  const publicStateText = JSON.stringify(await ipc('getState')); assert.doesNotMatch(publicStateText, /local-smoke-only/);
  assert.doesNotMatch(fs.readFileSync(configPath, 'utf8') + fs.readFileSync(claudeConfigPath, 'utf8'), /local-smoke-only/);
  check('ledger/public state/client fixture configs contain no fake vendor secret or chat text');
  const exported = await ipc('exportUsageReport'); assert.ok(exported.path.startsWith(path.join(fixture, 'exports') + path.sep));
  const csv = fs.readFileSync(exported.path, 'utf8'); assert.ok(csv.charCodeAt(0) === 0xfeff); assert.equal(csv.split('\r\n').length, 9); assert.match(csv, /未计价/); assert.doesNotMatch(csv, /LOCAL_SMOKE_PROMPT|LOCAL_SMOKE_RESPONSE_TEXT|local-smoke-only/); report.csv = exported.path;
  check('real CSV export retains unknown markers and excludes prompts/credentials');
  await refreshRenderer();
  await codexCard.getByLabel('API 连接', { exact: true }).selectOption(unpriced.id);
  await capture('v2-workbench.png');
  await navigate('用量与费用');
  await until(async () => (await page.locator('.metric-value').first().textContent()).includes('已知'), 'renderer displays partial known amount');
  assert.ok(await page.getByText('待补全', { exact: true }).count());
  await capture('v2-usage.png', true);
  await navigate('API 连接');
  await page.locator('.connection-card').filter({ hasText: '本机验收 · Claude Code' }).click();
  await capture('v2-connections.png', true);
  await page.setViewportSize({ width: 940, height: 700 });
  for (const label of ['工作台', '用量与费用', 'API 连接', '备份与设置']) {
    await navigate(label);
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth })); assert.ok(sizes.content <= sizes.viewport, `${label} has no horizontal viewport overflow`);
  }
  await page.locator('.topbar-actions').getByRole('button', { name: '工具路径设置', exact: true }).click();
  await page.getByRole('button', { name: '关闭路径设置', exact: true }).press('Escape');
  assert.equal(await page.getByRole('dialog', { name: '路径设置' }).count(), 0);
  check('all navigation pages fit 940px; settings dialog Escape restores control');
  await page.setViewportSize({ width: 1320, height: 880 });
  const beforeRollback = await ipc('getState');
  for (const engine of ['codex', 'claude']) {
    const backup = beforeRollback.companion.backups.find(item => item.engine === engine && item.canRestore); assert.ok(backup);
    const restored = await ipc('restoreConfigBackup', backup.id); assert.equal(restored.ok, true);
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), originalCodex); assert.equal(fs.readFileSync(claudeConfigPath, 'utf8'), originalClaude);
  assert.equal(Object.keys((await ipc('getState')).companion.gateway.routes).length, 0);
  check('real rollback restores exact fixture bytes and clears gateway routes');
  assert.deepEqual(report.rendererErrors, []);
  assert.ok(received.every(request => request.path.startsWith('/v1/') || request.path.startsWith('/anthropic/')));
  report.upstreamCalls = received.length;
  report.ok = true;
}
run().catch(async error => { report.error = error.stack || String(error); console.error(report.error); process.exitCode = 1; if (page) { report.lastUI = await page.locator('body').innerText().catch(() => ''); console.error('Last toast:', await page.locator('.toast').innerText({ timeout: 1000 }).catch(() => 'none')); await page.screenshot({ path: path.join(reportsDir, 'smoke-v2-failure.png'), fullPage: true }).catch(() => {}); } }).finally(async () => {
  await stopOwnApplication().catch(error => { report.cleanupError = String(error); process.exitCode = 1; });
  if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(reportsDir, 'smoke-v2-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, externalApiCalls: report.externalApiCalls, report: path.join(reportsDir, 'smoke-v2-report.json') }));
});
