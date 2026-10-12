const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');

function loadAdapter(customFs = fs) {
  const cipher = {
    available: true,
    isEncryptionAvailable() { return this.available; },
    encryptString(value) { return Buffer.from([...Buffer.from(value)].map(byte => byte ^ 113)); },
    decryptString(value) { return Buffer.from([...value].map(byte => byte ^ 113)).toString(); },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'claude-gui.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const unit = { exports: {} };
  vm.runInNewContext(compiled, {
    module: unit, exports: unit.exports, Buffer, URL, process,
    require: name => name === 'electron' ? { safeStorage: cipher }
      : name === 'node:fs' ? customFs
      : name === 'node:child_process' ? { spawnSync() { throw new Error('Fixture must not inspect real Windows processes or policies'); } }
      : require(name),
  }, { filename: 'claude-gui.ts' });
  return { ...unit.exports, cipher };
}
async function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-claude-gui-'));
  const resolved = path.resolve(dir), parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), parent);
  assert.ok(path.basename(resolved).startsWith('continuation-claude-gui-'));
  try { return await run(dir); }
  finally { if (path.dirname(resolved) === parent && path.basename(resolved).startsWith('continuation-claude-gui-')) fs.rmSync(resolved, { recursive: true, force: true }); }
}
function profile(overrides = {}) {
  return { connectionId: 'fixture-gui-connection', gatewayBaseUrl: 'http://127.0.0.1:41915/claude-desktop', gatewayToken: 'fixture-local-relay-token', model: 'claude-sonnet-4-6', ...overrides };
}
function create(module, dir, options = {}) {
  const configLibraryPath = path.join(dir, 'official-desktop-fixture', 'configLibrary');
  const backupDir = path.join(dir, 'encrypted-backups');
  const adapter = new module.ClaudeGuiAdapter({ configLibraryPath, backupDir, cipher: module.cipher, isRunning: () => false, isPolicyManaged: () => false, isSchemaSupported: () => true, ...options });
  return { adapter, configLibraryPath, backupDir, modePath: adapter.modePath, metaPath: adapter.metaPath, configPath: adapter.configPath };
}
function write(filename, raw) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, raw); }
async function apply(adapter, input = profile()) { await adapter.preview(input); return adapter.apply(input); }
const EXTERNAL_ID = '8cce44db-0ed4-4a69-983a-51089acfc855';

test('desktop preview is read-only, uses the independent desktop route and redacts secrets', async () => fixture(async dir => {
  const module = loadAdapter(), { adapter, configPath, modePath, metaPath, backupDir } = create(module, dir);
  const originalMode = JSON.stringify({ deploymentMode: '1p', customSetting: { token: 'fixture-hidden-mode-token' }, mcpServers: { retained: {} } }, null, 4);
  write(modePath, originalMode);
  const meta = JSON.stringify({ appliedId: EXTERNAL_ID, entries: [{ id: EXTERNAL_ID, name: 'Existing official entry' }], hybridPointer: { bootstrapUrl: 'https://fixture.invalid/config' } });
  write(metaPath, meta);
  const fingerprint = adapter.fingerprint();
  const preview = await adapter.preview(profile());
  assert.equal(preview.surface, 'desktop');
  assert.equal(preview.activationKind, 'auto');
  assert.match(preview.after, /\/claude-desktop/);
  assert.equal(preview.after.includes('fixture-local-relay-token'), false);
  assert.equal(preview.before.includes('fixture-hidden-mode-token'), false);
  assert.match(preview.after, /"deploymentMode": "3p"/);
  assert.equal(adapter.fingerprint(), fingerprint);
  assert.equal(fs.readFileSync(modePath, 'utf8'), originalMode);
  assert.equal(fs.readFileSync(metaPath, 'utf8'), meta);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(fs.existsSync(backupDir), false);
}));

test('API apply configures all three source-verified desktop files without touching another profile or credentials', async () => fixture(async dir => {
  let forbiddenPath;
  const wrappedFs = { ...fs, readFileSync(filename, ...args) { if (filename === forbiddenPath) throw new Error('Unowned profile must never be read'); return fs.readFileSync(filename, ...args); } };
  const module = loadAdapter(wrappedFs), { adapter, configLibraryPath, configPath, modePath, metaPath, backupDir } = create(module, dir);
  const externalPath = path.join(configLibraryPath, `${EXTERNAL_ID}.json`);
  forbiddenPath = externalPath;
  const external = JSON.stringify({ inferenceProvider: 'gateway', inferenceGatewayApiKey: 'fixture-other-profile-secret' });
  write(externalPath, external);
  write(metaPath, JSON.stringify({ appliedId: EXTERNAL_ID, entries: [{ id: EXTERNAL_ID, name: 'Keep me', customLabel: true }], hybridPointer: { bootstrapUrl: 'https://fixture.invalid' }, unrelated: { preserve: true } }));
  write(modePath, JSON.stringify({ deploymentMode: '1p', unrelated: 'preserve' }));
  const credentialPath = path.join(dir, 'credentials-untouched.json');
  write(credentialPath, 'fixture credential bytes');
  const result = await apply(adapter);
  assert.equal(result.ok, true);
  assert.equal(result.activationState, 'configured');
  assert.equal(result.restartRequired, true);
  const configured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(configured.inferenceProvider, 'gateway');
  assert.equal(configured.inferenceGatewayBaseUrl, profile().gatewayBaseUrl);
  assert.equal(configured.inferenceGatewayApiKey, profile().gatewayToken);
  assert.equal(configured.inferenceModels[0].name, profile().model);
  assert.equal(configured.modelDiscoveryEnabled, false);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.appliedId, module.CLAUDE_GUI_MANAGED_ID);
  assert.equal(meta.entries.length, 2);
  assert.equal(meta.entries[0].customLabel, true);
  assert.equal(meta.hybridPointer, undefined);
  assert.equal(meta.unrelated.preserve, true);
  assert.equal(JSON.parse(fs.readFileSync(modePath, 'utf8')).unrelated, 'preserve');
  assert.equal(fs.readFileSync(externalPath, 'utf8'), external);
  assert.equal(fs.readFileSync(credentialPath, 'utf8'), 'fixture credential bytes');
  const backup = fs.readFileSync(path.join(backupDir, `${result.backupId}.encrypted.json`), 'utf8');
  assert.equal(backup.includes('fixture-other-profile-secret'), false);
  assert.equal(backup.includes(profile().gatewayToken), false);
  const state = adapter.getStatus(profile());
  assert.equal(state.mode, 'api');
  assert.equal(state.model, profile().model);
  assert.equal(state.gatewayBaseUrl, profile().gatewayBaseUrl);
  assert.equal(state.activationState, 'configured');
  assert.equal(JSON.stringify(state).includes(profile().gatewayToken), false);
  assert.equal(adapter.listBackups()[0].canRestore, true);
}));

test('subscription recovery restores exact initial bytes and preserves the original baseline across API changes', async () => fixture(async dir => {
  const module = loadAdapter(), { adapter, configPath, metaPath, modePath } = create(module, dir);
  const initialMeta = '{"appliedId":"","entries":[],"keep":"before"}\r\n';
  const initialMode = '{  "deploymentMode": "1p", "mcpServers": { "keep": {} }, "privateToken": "fixture-original-secret"  }';
  write(metaPath, initialMeta); write(modePath, initialMode);
  await apply(adapter);
  await apply(adapter, profile({ model: 'claude-opus-4-6' }));
  const preview = await adapter.previewSubscription();
  assert.equal(preview.changed, true);
  assert.match(preview.warnings.join(' '), /不代表已经确认会员/);
  await adapter.applySubscription();
  assert.equal(fs.readFileSync(metaPath, 'utf8'), initialMeta);
  assert.equal(fs.readFileSync(modePath, 'utf8'), initialMode);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(adapter.getStatus().mode, 'subscription');
}));

test('when the three desktop files were absent, subscription recovery removes only the new owned files', async () => fixture(async dir => {
  const module = loadAdapter(), { adapter, configPath, metaPath, modePath, configLibraryPath } = create(module, dir);
  await apply(adapter);
  const otherPath = path.join(configLibraryPath, `${EXTERNAL_ID}.json`);
  write(otherPath, '{"keep":"unindexed unrelated profile"}');
  await adapter.previewSubscription(); await adapter.applySubscription();
  for (const filename of [configPath, metaPath, modePath]) assert.equal(fs.existsSync(filename), false);
  assert.equal(fs.readFileSync(otherPath, 'utf8'), '{"keep":"unindexed unrelated profile"}');
}));

test('latest backup restores one API step while retaining the first baseline for later recovery', async () => fixture(async dir => {
  const module = loadAdapter(), { adapter, configPath } = create(module, dir);
  await apply(adapter);
  const second = await apply(adapter, profile({ model: 'claude-opus-4-6' }));
  await adapter.restore(second.backupId);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).inferenceModels[0].name, profile().model);
  await adapter.previewSubscription(); await adapter.applySubscription();
  assert.equal(fs.existsSync(configPath), false);
}));

test('preview-to-apply CAS and post-takeover CAS preserve external changes to every managed desktop file', async () => fixture(async dir => {
  const module = loadAdapter(), { adapter, metaPath, configPath, modePath } = create(module, dir);
  await adapter.preview(profile());
  write(modePath, '{"deploymentMode":"1p","newUserSetting":true}');
  await assert.rejects(() => adapter.apply(profile()), /外部修改/);
  assert.equal(fs.existsSync(configPath), false);
  const applied = await apply(adapter);
  const originalMeta = fs.readFileSync(metaPath, 'utf8');
  write(metaPath, `${originalMeta}\n`);
  await assert.rejects(() => adapter.preview(profile()), /外部修改/);
  await assert.rejects(() => adapter.previewSubscription(), /外部修改/);
  await assert.rejects(() => adapter.restore(applied.backupId), /外部修改/);
  assert.equal(adapter.listBackups()[0].canRestore, false);
  assert.equal(fs.readFileSync(metaPath, 'utf8'), `${originalMeta}\n`);
}));

test('external edits during encrypted backup creation are detected before the first desktop write', async () => fixture(async dir => {
  const module = loadAdapter(), { adapter, metaPath, configPath, modePath } = create(module, dir);
  await adapter.preview(profile());
  const encrypt = module.cipher.encryptString.bind(module.cipher);
  module.cipher.encryptString = value => { write(metaPath, '{"appliedId":"","entries":[],"externalEdit":true}'); return encrypt(value); };
  await assert.rejects(() => adapter.apply(profile()), /外部修改/);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(fs.existsSync(modePath), false);
  assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8')).externalEdit, true);
}));

test('encryption availability, preview requirement, running process and managed policy are fail-closed', async () => fixture(async dir => {
  const module = loadAdapter();
  let running = false, managed = false;
  const { adapter, configPath } = create(module, dir, { isRunning: () => running, isPolicyManaged: () => managed });
  await assert.rejects(() => adapter.apply(profile()), /先预览/);
  await adapter.preview(profile());
  running = true;
  await assert.rejects(() => adapter.apply(profile()), /完全退出/);
  running = false; managed = true;
  await assert.rejects(() => adapter.apply(profile()), /管理策略/);
  managed = false; module.cipher.available = false;
  await assert.rejects(() => adapter.apply(profile()), /加密存储不可用/);
  assert.equal(fs.existsSync(configPath), false);
}));

test('malformed index, own-profile collision, symlinks, remote/CLI routes and credential paths are rejected', async () => fixture(async dir => {
  const module = loadAdapter(), { adapter, metaPath, configPath, configLibraryPath } = create(module, dir);
  assert.throws(() => new module.ClaudeGuiAdapter({ configLibraryPath: path.join(dir, '.credentials.json'), backupDir: path.join(dir, 'x') }), /凭据/);
  await assert.rejects(() => adapter.preview(profile({ gatewayBaseUrl: 'http://127.0.0.1:41915/claude' })), /桌面接入只允许/);
  await assert.rejects(() => adapter.preview(profile({ gatewayBaseUrl: 'https://fixture.invalid/claude-desktop' })), /桌面接入只允许/);
  write(metaPath, '{"appliedId":"not-a-uuid","entries":[]}');
  await assert.rejects(() => adapter.preview(profile()), /索引格式/);
  fs.unlinkSync(metaPath);
  write(configPath, '{"inferenceGatewayApiKey":"external-secret"}');
  await assert.rejects(() => adapter.preview(profile()), /外部文件/);
  fs.unlinkSync(configPath);
  const outside = path.join(dir, 'outside-fixture'); fs.mkdirSync(outside);
  fs.rmSync(configLibraryPath, { recursive: true });
  fs.symlinkSync(outside, configLibraryPath, 'junction');
  await assert.rejects(() => adapter.preview(profile()), /含链接/);
  assert.equal(fs.readdirSync(outside).length, 0);
}));

test('partial write failure rolls back bytes that still belong to the transaction', async () => fixture(async dir => {
  let fail = false;
  const wrappedFs = { ...fs, renameSync(from, to) { if (fail && path.basename(to) === 'claude_desktop_config.json') { fail = false; throw new Error('fixture disk failure'); } return fs.renameSync(from, to); } };
  const module = loadAdapter(wrappedFs), { adapter, metaPath, configPath, modePath } = create(module, dir);
  const originalMeta = '{"appliedId":"","entries":[]}'; write(metaPath, originalMeta);
  await adapter.preview(profile()); fail = true;
  await assert.rejects(() => adapter.apply(profile()), /fixture disk failure/);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(fs.existsSync(modePath), false);
  assert.equal(fs.readFileSync(metaPath, 'utf8'), originalMeta);
}));

test('a file edited while staging an atomic replacement is preserved instead of overwritten', async () => fixture(async dir => {
  let modePath, inject = false;
  const wrappedFs = { ...fs, writeFileSync(filename, contents, options) {
    fs.writeFileSync(filename, contents, options);
    if (inject && filename.startsWith(`${modePath}.`) && filename.endsWith('.tmp')) {
      inject = false; fs.writeFileSync(modePath, '{"deploymentMode":"1p","newExternalEdit":true}');
    }
  } };
  const module = loadAdapter(wrappedFs), fixtureValue = create(module, dir);
  modePath = fixtureValue.modePath;
  await fixtureValue.adapter.preview(profile()); inject = true;
  await assert.rejects(() => fixtureValue.adapter.apply(profile()), /外部修改/);
  assert.equal(JSON.parse(fs.readFileSync(modePath, 'utf8')).newExternalEdit, true);
  assert.equal(fs.existsSync(fixtureValue.configPath), false);
  assert.equal(fs.existsSync(fixtureValue.metaPath), false);
}));

test('status never claims verified and refuses a stale expected model or unmanaged current profile', async () => fixture(async dir => {
  const module = loadAdapter(), { adapter, metaPath } = create(module, dir);
  assert.equal(adapter.getStatus().activationState, 'unconfigured');
  await apply(adapter);
  assert.equal(adapter.getStatus(profile()).activationState, 'configured');
  assert.equal(adapter.getStatus(profile({ model: 'claude-haiku-4-5' })).activationState, 'unknown');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); meta.appliedId = EXTERNAL_ID; meta.entries.push({ id: EXTERNAL_ID, name: 'External' }); write(metaPath, JSON.stringify(meta));
  assert.equal(adapter.getStatus(profile()).activationState, 'external');
  assert.equal(adapter.getStatus().mode, 'unknown');
}));

test('source-verified model guard refuses Qwen and other non-Claude models before reading or modifying configuration', async () => fixture(async dir => {
  const module = loadAdapter(), { adapter, configPath, metaPath, modePath, backupDir } = create(module, dir);
  write(metaPath, '{"appliedId":"","entries":[]}');
  write(modePath, '{"deploymentMode":"1p","keep":"original"}');
  const before = adapter.fingerprint();
  for (const model of ['qwen3.8-max', 'deepseek-v4-pro', 'glm-5.3', 'kimi-k3', 'MiniMax-M2.5', 'unverified-custom-route', 'claude-qwen-proxy', 'sonnet']) {
    assert.match(module.claudeGuiModelIssue(model), /VS Code 图形扩展/);
    await assert.rejects(() => adapter.preview(profile({ model })), /配置未修改/);
    await assert.rejects(() => adapter.apply(profile({ model })), /配置未修改/);
    assert.throws(() => module.buildClaudeGuiGatewayConfig(profile({ model })), /配置未修改/);
  }
  assert.equal(adapter.fingerprint(), before);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(fs.existsSync(backupDir), false);
  assert.equal(module.claudeGuiModelIssue('claude-sonnet-4-6'), undefined);
  assert.equal(module.claudeGuiModelIssue('anthropic/claude-opus-4-6'), undefined);
  assert.equal(module.buildClaudeGuiGatewayConfig(profile({ model: 'anthropic/claude-opus-4-6' })).inferenceModels[0].anthropicFamilyTier, 'opus');
  assert.equal(module.buildClaudeGuiGatewayConfig(profile({ model: 'claude-haiku-4-5' })).inferenceModels[0].anthropicFamilyTier, 'haiku');
  assert.equal(module.buildClaudeGuiGatewayConfig(profile({ model: 'anthropic/custom-route' })).inferenceModels[0].anthropicFamilyTier, undefined);
}));

test('an unverified desktop version refuses every mutation and reports manual configuration guidance', async () => fixture(async dir => {
  const module = loadAdapter();
  let supported = true;
  const { adapter, configPath } = create(module, dir, { isSchemaSupported: () => supported });
  const applied = await apply(adapter);
  const before = adapter.fingerprint();
  supported = false;
  await assert.rejects(() => adapter.preview(profile()), /版本.*尚未核实/);
  await assert.rejects(() => adapter.previewSubscription(), /版本.*尚未核实/);
  await assert.rejects(() => adapter.restore(applied.backupId), /版本.*尚未核实/);
  assert.equal(adapter.fingerprint(), before);
  const status = adapter.getStatus(profile());
  assert.equal(status.activationKind, 'manual-import');
  assert.equal(status.activationState, 'unknown');
  assert.equal(status.model, profile().model);
  assert.match(status.message, /官方 Developer/);
  assert.equal(adapter.listBackups()[0].canRestore, false);
  assert.equal(fs.existsSync(configPath), true);
}));
