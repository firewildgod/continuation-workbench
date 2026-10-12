const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

const windowsPath = path.win32;
const desktopPath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture\\app\\ChatGPT.exe';
const appId = 'OpenAI.Codex_fixture!App';
const claudeGuiPath = 'C:\\Program Files\\WindowsApps\\Claude_fixture\\app\\claude.exe';
const claudeGuiAppId = 'Claude_fixture!App';
const claudePath = 'C:\\fixture tools\\Claude\'s $literal&(safe)\\claude.cmd';
const directory = 'C:\\项目资料\\Claude\'s $literal&(safe)';
const statusDir = 'C:\\fixture\\launch-status';
const statusFile = windowsPath.join(statusDir, 'claude-fixture-token.json');

function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('参数无效');
  return `'${value.replace(/'/g, "''")}'`;
}
function compiled(filename) {
  return ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/main', filename), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
}
function loadDetection(options = {}) {
  const executeCalls = [], spawnCalls = [], sleeps = [], mkdirCalls = [];
  let terminalStarted = false, statusReads = 0;
  const packageInfo = options.packageInstalled === false ? null : {
    InstallLocation: windowsPath.dirname(windowsPath.dirname(desktopPath)),
    PackageFamilyName: 'OpenAI.Codex_fixture',
  };
  const execFile = () => { throw new Error('Use the mocked promisified process boundary only'); };
  execFile[util.promisify.custom] = async (executable, args, settings) => {
    const encodedIndex = args.indexOf('-EncodedCommand');
    const script = encodedIndex >= 0 ? Buffer.from(args[encodedIndex + 1], 'base64').toString('utf16le') : args.at(-1);
    executeCalls.push({ executable, args, settings, script });
    if (executable === 'explorer.exe') {
      if (options.explorerError) throw new Error('Fixture activation failed');
      return { stdout: '', stderr: '' };
    }
    if (script.includes('Get-CimInstance')) return {
      stdout: JSON.stringify({
        processes: options.processes || (options.running ? [{ Name: 'ChatGPT.exe', ExecutablePath: desktopPath }] : []),
        package: packageInfo,
        claudePackage: options.claudeGuiInstalled ? { InstallLocation: windowsPath.dirname(windowsPath.dirname(claudeGuiPath)), PackageFamilyName: 'Claude_fixture' } : null,
      }), stderr: '',
    };
    if (script.includes('WorkbenchWindow')) {
      if (options.activationError) throw new Error('Fixture foreground restriction');
      return { stdout: JSON.stringify({ activated: options.activated !== false, pid: 3100 }), stderr: '' };
    }
    if (script.includes('Start-Process')) {
      if (options.terminalLauncherError) throw new Error('Fixture terminal process failed');
      terminalStarted = true;
      return { stdout: JSON.stringify({ pid: 4200 }), stderr: '' };
    }
    throw new Error('Unexpected process request in fixture');
  };
  const spawn = (executable, args, settings) => {
    spawnCalls.push({ executable, args, settings });
    const child = new EventEmitter();
    child.unref = () => { child.unreferenced = true; };
    queueMicrotask(() => options.spawnError ? child.emit('error', new Error('Fixture EXE failed')) : child.emit('spawn'));
    return child;
  };
  const mockFs = {
    existsSync(filename) {
      if (filename === statusFile) return terminalStarted && options.statusMissing !== true;
      return [desktopPath, claudePath, claudeGuiPath].includes(filename) || windowsPath.basename(filename) === 'AppxManifest.xml';
    },
    readFileSync(filename) {
      if (windowsPath.basename(filename) === 'AppxManifest.xml') return '<Application Id="App" />';
      assert.equal(filename, statusFile, 'only the app launch marker may be read');
      const sequence = options.statusSequence || [{ phase: options.phase || 'ready', pid: 4200, message: 'Fixture launch error' }];
      const status = sequence[Math.min(statusReads++, sequence.length - 1)];
      return typeof status === 'string' ? status : '\uFEFF' + JSON.stringify(status);
    },
    statSync(filename) {
      assert.equal(filename, directory);
      return { isDirectory: () => options.invalidDirectory !== true };
    },
    mkdirSync(filename, settings) { mkdirCalls.push({ filename, settings }); },
  };
  const unit = { exports: {} };
  vm.runInNewContext(compiled('detection.ts'), {
    module: unit, exports: unit.exports,
    require(name) {
      if (name === 'node:child_process') return { execFile, spawn };
      if (name === 'node:fs') return mockFs;
      if (name === 'node:path') return windowsPath;
      if (name === 'node:os') return { tmpdir: () => 'C:\\fixture\\temp' };
      if (name === 'node:crypto') return { randomUUID: () => 'fixture-token' };
      if (name === './services') return { quotePowerShellArgument: quote };
      return require(name);
    },
    process: { env: { SystemRoot: 'C:\\Windows' } }, Buffer,
    setTimeout(callback, delay) { sleeps.push(delay); queueMicrotask(callback); return 1; },
  }, { filename: 'detection.ts' });
  return { ...unit.exports, executeCalls, spawnCalls, sleeps, mkdirCalls };
}

test('opening a running Codex activates its existing window without quitting or spawning another app', async () => {
  const module = loadDetection({ running: true });
  const result = await module.launchCodexDesktop(desktopPath);
  assert.equal(result.action, 'activated');
  assert.equal(result.pid, 3100);
  assert.match(result.message, /当前任务保留/);
  assert.equal(module.spawnCalls.length, 0);
  assert.equal(module.executeCalls.length, 2);
  const activation = module.executeCalls[1];
  assert.match(activation.script, /ShowWindowAsync\(hwnd,9\)/);
  assert.match(activation.script, /SetForegroundWindow/);
  assert.match(activation.script, /AppActivate/);
  assert.match(activation.script, /GetWindowThreadProcessId\(GetForegroundWindow\(\),out owner\); return owner==processId/);
  assert.match(activation.script, /AttachThreadInput\(current,foreground,true\)/);
  assert.match(activation.script, /finally\s*\{[\s\S]*AttachThreadInput\(current,target,false\)[\s\S]*AttachThreadInput\(current,foreground,false\)/);
  assert.equal(activation.settings.windowsHide, true);
  assert.doesNotMatch(module.executeCalls.map(call => call.script).join('\n'), /Stop-Process|taskkill|\.Kill\(/i);
});

test('a foreground restriction falls back to the installed official Codex entry and reports the taskbar limit', async () => {
  const module = loadDetection({ running: true, activated: false });
  const result = await module.launchCodexDesktop(desktopPath);
  assert.equal(result.action, 'opened');
  assert.match(result.message, /任务栏/);
  assert.equal(module.spawnCalls.length, 0);
  const entry = module.executeCalls.at(-1);
  assert.equal(entry.executable, 'explorer.exe');
  assert.equal(entry.args[0], `shell:AppsFolder\\${appId}`);
});

test('opening stopped Codex uses its package entry rather than starting the CLI', async () => {
  const module = loadDetection();
  const result = await module.launchCodexDesktop(desktopPath);
  assert.equal(result.action, 'opened');
  assert.match(result.message, /官方入口/);
  assert.equal(module.executeCalls.at(-1).executable, 'explorer.exe');
  assert.equal(module.spawnCalls.length, 0);
});

test('an official entry activation error is rejected instead of reporting that Codex opened', async () => {
  const module = loadDetection({ explorerError: true });
  await assert.rejects(module.launchCodexDesktop(desktopPath), /官方 Codex 应用入口未能启动/);
  assert.equal(module.spawnCalls.length, 0);
});

test('running Codex with foreground denied and an Explorer activation error keeps the existing task and returns a taskbar fallback', async () => {
  const module = loadDetection({ running: true, activated: false, explorerError: true });
  const result = await module.launchCodexDesktop(desktopPath);
  assert.equal(result.action, 'opened');
  assert.match(result.message, /未确认自动置前/);
  assert.match(result.message, /任务栏/);
  assert.match(result.message, /无需关闭当前任务/);
  assert.equal(module.spawnCalls.length, 0, 'a failed activation must not create another Codex instance');
  assert.equal(module.executeCalls.filter(call => call.script.includes('Get-CimInstance')).length, 2,
    'the running app must be rechecked before accepting an activation fallback');
  assert.equal(module.executeCalls.filter(call => call.executable === 'explorer.exe').length, 1);
  assert.doesNotMatch(module.executeCalls.map(call => call.script).join('\n'), /Stop-Process|taskkill|\.Kill\(/i);
});

test('Claude creates a visible separate PowerShell terminal and confirms an interactive readiness marker', async () => {
  const module = loadDetection({ statusSequence: ['{', { phase: 'ready', pid: 4200 }] });
  const result = await module.launchClaudeTerminal(claudePath, directory, statusDir);
  assert.equal(result.action, 'opened');
  assert.equal(result.pid, 4200);
  assert.match(result.message, /可交互/);
  assert.equal(module.spawnCalls.length, 0, 'the CLI must not receive Node ignore/null standard handles');
  assert.equal(module.executeCalls.length, 1);
  const outer = module.executeCalls[0];
  assert.equal(outer.settings.windowsHide, true, 'only the short-lived launcher is hidden');
  assert.match(outer.script, /Start-Process/);
  assert.match(outer.script, /-WindowStyle Normal/);
  assert.match(outer.script, /-PassThru/);
  assert.match(outer.script, /-NoExit -EncodedCommand [A-Za-z0-9+/=]+/);
  assert.doesNotMatch(outer.script, /-NoNewWindow|-RedirectStandardInput|-RedirectStandardOutput/);
  const encoded = outer.script.match(/-NoExit -EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
  const inner = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(inner, /IsInputRedirected/);
  assert.match(inner, /IsOutputRedirected/);
  assert.match(inner, /Write-LaunchStatus 'ready'/);
  assert.ok(inner.includes(`Set-Location -LiteralPath ${quote(directory)}`));
  assert.ok(inner.includes(`& ${quote(claudePath)}`));
  assert.ok(inner.includes(`Set-Content -LiteralPath ${quote(statusFile)}`));
  assert.equal(module.sleeps.length, 1, 'an incompletely written marker must be retried');
});

test('Claude terminal launcher failure is rejected without a false opened result', async () => {
  const module = loadDetection({ terminalLauncherError: true });
  await assert.rejects(module.launchClaudeTerminal(claudePath, directory, statusDir), /无法创建.*交互终端/);
  assert.equal(module.sleeps.length, 0);
});

test('Claude failed and immediately ended markers are surfaced to the user', async () => {
  for (const [phase, message] of [['failed', /Fixture launch error/], ['ended', /已退出/]]) {
    const module = loadDetection({ phase });
    await assert.rejects(module.launchClaudeTerminal(claudePath, directory, statusDir), message);
    assert.equal(module.spawnCalls.length, 0);
  }
});

test('a missing Claude readiness marker reports unconfirmed status instead of success', async () => {
  const module = loadDetection({ statusMissing: true });
  await assert.rejects(module.launchClaudeTerminal(claudePath, directory, statusDir), /状态尚未确认.*4200/);
  assert.equal(module.sleeps.length, 48);
});

test('activation and terminal scripts preserve Chinese and shell metacharacters as literal quoted paths', () => {
  const module = loadDetection();
  const activation = module.codexActivationScript(claudePath);
  assert.ok(activation.includes(`$_.Path -eq ${quote(claudePath)}`));
  const terminal = module.claudeTerminalScript(claudePath, directory, statusFile);
  assert.ok(terminal.includes(quote(directory)));
  assert.ok(terminal.includes(quote(claudePath)));
  assert.throws(() => module.claudeTerminalScript(`${claudePath}\nStop-Process`, directory, statusFile), /无效/);
  assert.doesNotMatch(terminal, /Stop-Process|taskkill|Remove-Item|DeleteFile/i);
});

test('configuration mutation still requires closing running official Codex even though opening it now activates', async () => {
  const unit = { exports: {} };
  vm.runInNewContext(compiled('manager.ts'), {
    module: unit, exports: unit.exports,
    require(name) {
      if (name === 'electron') return { safeStorage: {} };
      if (name === './services') return { WorkbenchServices: class {} };
      if (name === './gateway') return { LocalGateway: class {} };
      if (name === './usage') return { UsageLedger: class {} };
      if (name === './codex-desktop') return { CodexDesktopAdapter: class {} };
      if (name === './claude-desktop') return { ClaudeDesktopAdapter: class {} };
      if (name === './claude-gui') return { ClaudeGuiAdapter: class {} };
      if (name === './detection') return { detectDesktops: async () => ({ codexRunning: true }) };
      if (name === 'node:path') return windowsPath;
      return require(name);
    }, process: { env: {} }, Buffer,
  }, { filename: 'manager.ts' });
  const manager = Object.create(unit.exports.ConnectionManager.prototype);
  const configPath = 'C:\\fixture\\official-codex\\config.toml';
  manager.dataDir = 'C:\\fixture\\manager-data';
  manager.services = { getSettings: () => ({ codexConfigPath: configPath }) };
  manager.codexAdapter = { configPath };
  let mutations = 0, pauses = 0;
  manager.gateway = { status: () => ({ activeRequests: 0 }), activeRequestsFor: () => 0, pause: () => { pauses++; }, resume: () => {} };
  await assert.rejects(manager.mutate('codex', async () => { mutations++; }), /完全退出官方 Codex/);
  assert.equal(mutations, 0);
  assert.equal(pauses, 0);
  assert.equal(manager.isMutating, false);
});

test('Claude desktop processes do not claim that the Claude Code CLI is running', async () => {
  for (const ExecutablePath of [
    'C:\\Program Files\\WindowsApps\\Claude_fixture\\app\\Claude.exe',
    'C:\\Users\\fixture\\AppData\\Local\\Claude\\Claude.exe',
    'C:\\Program Files\\Claude Desktop\\app\\Claude.exe',
    undefined,
  ]) {
    const module = loadDetection({ processes: [{ Name: 'Claude.exe', ExecutablePath }] });
    assert.equal((await module.detectDesktops(true)).claudeRunning, false);
  }
});

test('only executable paths that establish Claude Code CLI ownership report running', async () => {
  const executable = 'C:\\Users\\fixture\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const module = loadDetection({ processes: [{ Name: 'claude.exe', ExecutablePath: executable }] });
  assert.equal((await module.detectDesktops(true)).claudeRunning, true);
  assert.equal(module.isClaudeCodeCliProcess({ Name: 'claude.exe', ExecutablePath: 'C:\\Users\\fixture\\.local\\bin\\claude.exe' }), true);
  assert.equal(module.isClaudeCodeCliProcess({ Name: 'node.exe', ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe' }), false);
  assert.equal(module.isClaudeCodeCliProcess({ Name: 'claude.exe', ExecutablePath: 'C:\\unknown\\claude.exe' }), false);
});

test('Claude GUI package discovery and launch use the official app entry without creating a terminal', async () => {
  const module = loadDetection({ claudeGuiInstalled: true, processes: [{ Name: 'claude.exe', ExecutablePath: claudeGuiPath }] });
  const detected = await module.detectDesktops(true);
  assert.equal(detected.claudeDesktopPath, claudeGuiPath);
  assert.equal(detected.claudeDesktopAppId, claudeGuiAppId);
  assert.equal(detected.claudeDesktopRunning, true);
  assert.equal(detected.claudeRunning, false);
  const opened = await module.launchClaudeGui(claudeGuiPath);
  assert.equal(opened.action, 'opened');
  assert.equal(module.executeCalls.at(-1).executable, 'explorer.exe');
  assert.equal(module.executeCalls.at(-1).args[0], `shell:AppsFolder\\${claudeGuiAppId}`);
  assert.equal(module.spawnCalls.length, 0);
  assert.doesNotMatch(module.executeCalls.map(call => call.script).join('\n'), /Start-Process|Stop-Process|taskkill/i);
});

test('Claude GUI launch rejects terminal paths and propagates launch failure', async () => {
  const cli = loadDetection({ packageInstalled: false });
  await assert.rejects(cli.launchClaudeGui(claudePath), /终端程序不能代替/);
  assert.equal(cli.spawnCalls.length, 0);
  const broken = loadDetection({ claudeGuiInstalled: true, explorerError: true });
  await assert.rejects(broken.launchClaudeGui(claudeGuiPath), /Fixture activation failed/);
});
