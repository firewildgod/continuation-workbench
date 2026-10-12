/* Explicitly authorized, bounded live QA. Never print or read vendor API keys. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const http = require('node:http');
const { resolveClaudeCommand } = require('./runtime-paths.cjs');

const root = path.resolve(__dirname, '..');
const qaDir = path.join(root, '.qa', 'v0.2-user');
const retest = process.argv.includes('--retest-cli');
const originalReportPath = path.join(qaDir, 'claude-live-report.json');
const reportPath = retest ? path.join(qaDir, 'claude-live-retest-report.json') : originalReportPath;
const reportExistedAtStartup = fs.existsSync(reportPath);
const report = { startedAt: new Date().toISOString(), pass: false, connectionTest: null, cli: null, usage: [], safeIsolation: false };
const resume = retest || process.argv.includes('--resume-cli');
const prior = resume && fs.existsSync(originalReportPath) ? JSON.parse(fs.readFileSync(originalReportPath, 'utf8')) : undefined;
let captureSince = retest ? report.startedAt : prior?.startedAt || report.startedAt;
function within(filename) {
  const relative = path.relative(qaDir, path.resolve(filename));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function requireQA(filename) { assert.equal(within(filename), true, 'QA path guard failed'); return path.resolve(filename); }
function psQuote(value) { assert.equal(/[\r\n\0]/.test(value), false); return `'${value.replace(/'/g, "''")}'`; }
async function connectCDP() {
  const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
  const target = targets.find(item => item.type === 'page' && item.url.startsWith('file:'));
  assert.ok(target?.webSocketDebuggerUrl, 'No isolated QA page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const waiting = new Map();
  socket.addEventListener('message', ({ data }) => {
    let message; try { message = JSON.parse(String(data)); } catch { return; }
    const handler = waiting.get(message.id); if (!handler) return;
    waiting.delete(message.id); clearTimeout(handler.timeout);
    if (message.error || message.result?.exceptionDetails) handler.reject(new Error('QA CDP operation rejected'));
    else handler.resolve(message.result?.result?.value);
  });
  return {
    async evaluate(expression) {
      const id = ++sequence;
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { waiting.delete(id); reject(new Error('QA CDP timeout')); }, 40000);
        waiting.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
    },
    close() { socket.close(); },
  };
}
function invoke(cdp, method, args = []) { return cdp.evaluate(`window.desktop.${method}(...${JSON.stringify(args)})`); }
function isolatedEnvironment(settingsDir, sampleDir) {
  const userDir = requireQA(path.join(qaDir, 'cli-home'));
  const tempDir = requireQA(path.join(qaDir, 'cli-temp'));
  fs.mkdirSync(userDir, { recursive: true }); fs.mkdirSync(tempDir, { recursive: true });
  const result = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) result[key] = process.env[key];
  Object.assign(result, {
    HOME: userDir, USERPROFILE: userDir, APPDATA: path.join(userDir, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(userDir, 'AppData', 'Local'),
    TEMP: tempDir, TMP: tempDir, CLAUDE_CONFIG_DIR: settingsDir, DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_API_KEY: '', ANTHROPIC_CUSTOM_HEADERS: '', CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '512', CLAUDE_CODE_EFFORT_LEVEL: 'low', MAX_THINKING_TOKENS: '0',
    ANTHROPIC_MAX_RETRIES: '0', CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  });
  const onboarding = JSON.stringify({ hasCompletedOnboarding: true, projects: { [sampleDir]: { hasTrustDialogAccepted: true } } });
  // Both possible CLI onboarding locations are QA-owned. No global login is read.
  fs.writeFileSync(path.join(userDir, '.claude.json'), onboarding);
  fs.writeFileSync(path.join(settingsDir, '.claude.json'), onboarding);
  return result;
}
function runCLI(shim, args, cwd, env, timeoutMs) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& ${[shim, ...args].map(psQuote).join(' ')}; exit $LASTEXITCODE`], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderrBytes = 0, exceeded = false, timedOut = false;
    const stopOwnTree = () => {
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        // Only this freshly spawned hidden QA process tree; never a user process.
        spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
    };
    const timer = setTimeout(() => { timedOut = true; stopOwnTree(); }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length + chunk.length <= 2 * 1024 * 1024) stdout += chunk.toString(); else { exceeded = true; stopOwnTree(); } });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    child.on('error', () => { clearTimeout(timer); resolve({ exitCode: -1, stdout: '', stderrBytes, spawnFailed: true }); });
    child.on('close', exitCode => { clearTimeout(timer); resolve({ exitCode, stdout, stderrBytes, timedOut, exceeded }); });
  });
}
function numeric(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
async function requestBudgetProxy() {
  let forwarded = 0;
  const active = new Set();
  const server = http.createServer(async (request, response) => {
    const suffix = request.url || '';
    if (request.method !== 'POST' || !['/claude/v1/messages', '/claude/v1/messages?beta=true'].includes(suffix)) { response.writeHead(404); response.end('{}'); return; }
    if (forwarded >= 3) { response.writeHead(429, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Isolated QA request allowance exhausted; do not retry.' } })); return; }
    forwarded++;
    const controller = new AbortController(); active.add(controller);
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new Error('QA body too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Number.isFinite(body.max_tokens) || body.max_tokens > 512) throw new Error('QA output guard failed');
      if ((body.tools || []).some(tool => !['Read', 'Write'].includes(tool.name))) throw new Error('QA tool guard failed');
      const headers = {};
      for (const name of ['authorization', 'x-api-key', 'content-type', 'anthropic-version', 'anthropic-beta', 'accept']) if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
      const upstream = await fetch(`http://127.0.0.1:53189${suffix}`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      if (upstream.body) for await (const chunk of upstream.body) if (!response.destroyed) response.write(chunk);
      response.end();
    } catch { if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' }); if (!response.destroyed) response.end('{}'); }
    finally { active.delete(controller); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/claude`, count: () => forwarded,
    async close() { for (const controller of active) controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function safeUsage(records) {
  return records.map(record => ({ kind: record.kind, engine: record.engine, model: record.model,
    httpStatus: record.httpStatus, outcome: record.outcome, costCNY: numeric(record.costCNY),
    inputTokens: numeric(record.tokens?.inputTokens), outputTokens: numeric(record.tokens?.outputTokens), cacheReadTokens: numeric(record.tokens?.cacheReadTokens), cacheWriteTokens: numeric(record.tokens?.cacheWriteTokens) }));
}
async function main() {
  if (retest) assert.equal(reportExistedAtStartup, false, 'Authorized retest is one-shot');
  report.stage = 'connect-cdp';
  const cdp = await connectCDP();
  try {
    report.stage = 'check-isolation';
    const state = await invoke(cdp, 'getState');
    report.isolationChecks = { exactDataDir: path.resolve(state.dataDir).toLowerCase() === qaDir.toLowerCase(), configPaths: Object.fromEntries(Object.entries(state.settings).filter(([key]) => /ConfigPath$/.test(key)).map(([key, value]) => [key, Boolean(value) && within(value)])), claudeConnections: state.connections.filter(connection => connection.engine === 'claude').map(connection => ({ protocol: connection.protocol, wrongEndpoint: connection.baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode/v1', fixedEndpoint: connection.baseUrl === 'https://dashscope.aliyuncs.com/apps/anthropic', hasKey: connection.hasKey })) };
    assert.equal(path.resolve(state.dataDir).toLowerCase(), qaDir.toLowerCase(), 'Unexpected data directory');
    for (const [key, value] of Object.entries(state.settings)) if (/ConfigPath$/.test(key)) requireQA(value);
    if (resume) assert.equal(prior?.safeIsolation === true && prior?.connectionTest?.pass === true && (retest ? prior?.diagnosis?.confirmedByOfflineMock === true : prior?.cli === null), true, 'No safely completed preflight to resume');
    const candidates = state.connections.filter(connection => connection.engine === 'claude' && connection.protocol === 'anthropic' && connection.baseUrl === (resume ? 'https://dashscope.aliyuncs.com/apps/anthropic' : 'https://dashscope.aliyuncs.com/compatible-mode/v1'));
    assert.equal(candidates.length, 1, 'Expected exactly one copied faulty Claude connection');
    const connection = candidates[0]; assert.equal(connection.hasKey, true);
    report.stage = 'save-qa-connection';
    let fixed = resume ? connection : await invoke(cdp, 'saveConnection', [{ id: connection.id, name: connection.name, presetId: 'bailian-payg', engine: 'claude', protocol: 'anthropic', model: 'qwen3.8-flash', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' }]);
    assert.equal(fixed.id, connection.id); assert.equal(fixed.hasKey, true);
    if (retest) {
      assert.equal(fixed.presetId, 'bailian-payg'); assert.equal(fixed.model, 'qwen3.8-flash');
      fixed = await invoke(cdp, 'savePricing', [{ connectionId: fixed.id, pricing: { currency: 'CNY', inputPerMillion: 0.8, outputPerMillion: 2.7, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25, source: '百炼公开价 · 2026-10-11', updatedAt: new Date().toISOString() } }]);
      report.pricingConfirmed = fixed.pricing?.cacheWritePerMillion === 1.25;
    }
    const settingsFile = requireQA(state.settings.claudeConfigPath);
    const settingDir = requireQA(path.dirname(settingsFile));
    const input = { engine: 'claude', mode: 'api', connectionId: fixed.id };
    report.stage = 'apply-qa-fixture';
    if (!retest) {
      const preview = await invoke(cdp, 'previewToolConfig', [input]); requireQA(preview.configPath);
      const applied = await invoke(cdp, 'applyToolConfig', [input]); assert.equal(applied.ok, true);
    } else assert.equal(state.companion.gateway.routes.claude, fixed.id, 'QA route changed');
    const fixture = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(fixture.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:53189/claude');
    assert.match(fixture.env.ANTHROPIC_AUTH_TOKEN, /^[a-f0-9]{64}$/);
    assert.equal(fixture.env.ANTHROPIC_API_KEY, ''); assert.equal(fixture.env.CLAUDE_CODE_OAUTH_TOKEN, '');
    report.safeIsolation = true;
    report.stage = 'single-connection-test';
    const before = await invoke(cdp, 'getUsageRecords', [{ range: 'all', limit: 10000 }]);
    const beforeIds = new Set(before.map(record => record.id));
    if (resume && !retest) {
      const originalTest = before.find(record => record.connectionId === fixed.id && record.kind === 'connection-test' && record.outcome === 'success');
      assert.ok(originalTest, 'Successful original test record missing');
      captureSince = originalTest.startedAt;
    }
    report.captureSince = captureSince;
    const test = resume ? { ok: prior.connectionTest.pass, status: prior.connectionTest.status, elapsedMs: prior.connectionTest.elapsedMs } : await invoke(cdp, 'testConnection', [fixed.id]);
    report.connectionTest = { pass: test.ok, status: test.status, elapsedMs: test.elapsedMs, reusedEarlierResult: resume };
    if (!test.ok) { report.failure = 'Connection test failed; no repeated paid retry'; report.usage = safeUsage((await invoke(cdp, 'getUsageRecords', [{ range: 'all', limit: 10000 }])).filter(record => !beforeIds.has(record.id))); return; }
    const sampleDir = requireQA(path.join(qaDir, retest ? 'sample-project-retest' : 'sample-project'));
    fs.mkdirSync(sampleDir, { recursive: true });
    fs.writeFileSync(path.join(sampleDir, 'note.txt'), retest ? 'PORTABLE-CLAUDE-RETEST-20261011\n' : 'PORTABLE-CLAUDE-QA-20261011\n', 'utf8');
    assert.equal(fs.existsSync(path.join(sampleDir, 'result.txt')), false, 'Run once; existing result would hide a failed write');
    const shim = resolveClaudeCommand();
    const env = isolatedEnvironment(settingDir, sampleDir);
    Object.assign(env, fixture.env);
    report.stage = 'cli-help';
    // --max-turns is intentionally hidden from the installed CLI's help text.
    // Ask the parser to accept it, and also enforce the network allowance below.
    const help = await runCLI(shim, ['--max-turns', '3', '--help'], sampleDir, env, 20000);
    const required = ['--tools', '--allowedTools', '--permission-mode', '--no-session-persistence', '--setting-sources'];
    report.cliPreflight = { exitCode: help.exitCode, missingFlags: required.filter(flag => !help.stdout.includes(flag)), stdoutBytes: help.stdout.length, stderrBytes: help.stderrBytes, timedOut: Boolean(help.timedOut) };
    assert.equal(help.exitCode, 0, 'CLI help unavailable');
    for (const flag of required) assert.equal(help.stdout.includes(flag), true, 'Required CLI isolation flag unavailable');
    // This extra QA-only loopback relay enforces at most three provider requests,
    // even if the installed CLI ignores retry environment variables.
    const budgetProxy = await requestBudgetProxy();
    const cliSettings = requireQA(path.join(qaDir, retest ? 'cli-retest.settings.json' : 'cli-settings.json'));
    const bounded = structuredClone(fixture); bounded.env.ANTHROPIC_BASE_URL = budgetProxy.url;
    fs.writeFileSync(cliSettings, JSON.stringify(bounded));
    env.ANTHROPIC_BASE_URL = budgetProxy.url;
    const args = ['-p', 'Use Read to read only note.txt in the current directory. Then use Write to create only result.txt in the current directory with the exact same UTF-8 contents, including the single final newline. Do not copy Read display line numbers into the file. Do not access any other file, invoke any other tool, use a subagent, or make network calls. Reply DONE after writing.',
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'user',
      '--settings', cliSettings, '--model', 'qwen3.8-flash', '--max-turns', '3', '--tools', 'Read,Write',
      // Claude consults Edit(path) for Write tool paths. Write(path) is ignored.
      '--allowedTools', 'Read(./note.txt)', 'Edit(./result.txt)', '--permission-mode', 'dontAsk'];
    let result;
    report.stage = 'bounded-cli-tools';
    try { result = await runCLI(shim, args, sampleDir, env, 110000); }
    finally { await budgetProxy.close(); }
    const events = [];
    for (const line of result.stdout.split(/\r?\n/)) { try { events.push(JSON.parse(line)); } catch { /* Discard non-JSON output. */ } }
    let readTools = 0, writeTools = 0, otherTools = 0, successfulReads = 0, successfulWrites = 0, toolErrors = 0, permissionDenials = 0;
    const toolRequests = new Map();
    const targetChecks = [];
    for (const event of events) for (const block of event.message?.content || []) if (block.type === 'tool_use') {
      if (block.name === 'Read') readTools++; else if (block.name === 'Write') writeTools++; else otherTools++;
      toolRequests.set(block.id, block.name);
      const filePath = block.input?.file_path;
      targetChecks.push({ tool: ['Read', 'Write'].includes(block.name) ? block.name : 'other', targetInsideQA: typeof filePath === 'string' && within(path.resolve(sampleDir, filePath)), expectedBasename: typeof filePath === 'string' && path.basename(filePath) === (block.name === 'Read' ? 'note.txt' : 'result.txt') });
    }
    for (const event of events) for (const block of event.message?.content || []) if (block.type === 'tool_result') {
      const tool = toolRequests.get(block.tool_use_id);
      const text = typeof block.content === 'string' ? block.content : '';
      const permissionDenied = /permission|not allowed|denied|approval|权限/i.test(text);
      if (permissionDenied) permissionDenials++;
      if (block.is_error === true || permissionDenied) toolErrors++;
      else if (tool === 'Read') successfulReads++;
      else if (tool === 'Write') successfulWrites++;
    }
    const final = events.findLast(event => event.type === 'result');
    const output = path.join(sampleDir, 'result.txt');
    const fileMatch = fs.existsSync(output) && fs.readFileSync(output, 'utf8') === fs.readFileSync(path.join(sampleDir, 'note.txt'), 'utf8');
    report.cli = { pass: result.exitCode === 0 && fileMatch && successfulReads > 0 && successfulWrites > 0 && otherTools === 0 && final?.is_error !== true,
      exitCode: result.exitCode, timedOut: Boolean(result.timedOut), readToolsRequested: readTools, writeToolsRequested: writeTools, otherToolsRequested: otherTools,
      successfulReads, successfulWrites, toolErrors, permissionDenials, targetChecks, resultFileExists: fs.existsSync(output), fileMatch,
      turns: numeric(final?.num_turns), stderrBytes: result.stderrBytes, boundedRequests: budgetProxy.count() };
    report.usage = safeUsage((await invoke(cdp, 'getUsageRecords', [{ range: 'all', limit: 10000 }])).filter(record => !beforeIds.has(record.id)));
    assert.equal(report.usage.length <= (retest ? 3 : 4), true, 'Live request budget exceeded');
    report.pass = report.connectionTest.pass && report.cli.pass && report.usage.some(record => record.kind === 'request' && record.engine === 'claude' && record.httpStatus === 200 && record.inputTokens !== null);
    if (!report.pass) report.failure = 'Bounded CLI acceptance failed; no paid retry performed';
  } finally {
    if (report.safeIsolation) {
      try { report.usage = safeUsage((await invoke(cdp, 'getUsageRecords', [{ range: 'all', limit: 10000 }])).filter(record => record.engine === 'claude' && record.startedAt >= captureSince)); } catch { /* Preserve the already projected metadata. */ }
    }
    cdp.close();
  }
}
module.exports = { runCLI, isolatedEnvironment };
if (require.main === module) main().catch(() => { report.failure = 'QA guard or operation failed; sensitive error detail suppressed'; }).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(qaDir, { recursive: true });
  if (!(retest && reportExistedAtStartup)) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  // The report is a strict metadata projection; no credentials or raw model output.
  process.stdout.write(JSON.stringify(report));
  process.exitCode = report.pass ? 0 : 1;
});
