const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');

function loadAdapter() {
  let available = true;
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 81)),
    decryptString: value => Buffer.from([...value].map(byte => byte ^ 81)).toString(),
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'claude-desktop.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const unit = { exports: {} };
  vm.runInNewContext(compiled, { module: unit, exports: unit.exports, require: name => name === 'electron' ? { safeStorage } : require(name), Buffer, URL, structuredClone }, { filename: 'claude-desktop.ts' });
  return { ...unit.exports, setEncryptionAvailable: value => { available = value; } };
}
async function fixture(run) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-claude-config-'));
  const resolved = path.resolve(fixtureRoot);
  const tempRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), tempRoot);
  assert.equal(path.basename(resolved).startsWith('continuation-claude-config-'), true);
  try { return await run(fixtureRoot); }
  finally {
    if (path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith('continuation-claude-config-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
function profile(overrides = {}) {
  return { connectionId: 'fixture-connection', gatewayBaseUrl: 'http://127.0.0.1:41915/claude', gatewayToken: 'fixture-local-token', model: 'fixture-model', ...overrides };
}
function createAdapter(module, dir, original) {
  const settingsPath = path.join(dir, 'official-fixture', 'settings.json');
  if (original !== undefined) { fs.mkdirSync(path.dirname(settingsPath), { recursive: true }); fs.writeFileSync(settingsPath, original); }
  return { settingsPath, backupDir: path.join(dir, 'backups'), adapter: new module.ClaudeDesktopAdapter({ settingsPath, backupDir: path.join(dir, 'backups') }) };
}

test('Claude preview is read-only and hides existing vendor credentials and new local tokens', async () => fixture(async dir => {
  const module = loadAdapter();
  const original = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-existing-key', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: old-secret' }, apiKeyHelper: 'echo old-secret', hooks: { SessionStart: [] } });
  const { settingsPath, adapter } = createAdapter(module, dir, original);
  const preview = await adapter.preview(profile());
  assert.equal(preview.before.includes('fixture-existing-key'), false);
  assert.equal(preview.before.includes('old-secret'), false);
  assert.equal(preview.after.includes('fixture-local-token'), false);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
}));

test('applying the local gateway preserves unrelated hooks, permissions, plugins and env entries', async () => fixture(async dir => {
  const module = loadAdapter();
  const originalValue = { env: { ANTHROPIC_API_KEY: 'fixture-original-secret', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: fixture-old-header', OTHER_OPTION: 'preserve' }, apiKeyHelper: 'old-helper', hooks: { SessionStart: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo custom' }] }] }, permissions: { allow: ['Read'] }, customPlugin: 'leave' };
  const { settingsPath, backupDir, adapter } = createAdapter(module, dir, JSON.stringify(originalValue, null, 2));
  const applied = await adapter.apply(profile());
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, profile().gatewayBaseUrl);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, profile().gatewayToken);
  assert.equal(settings.env.ANTHROPIC_API_KEY, '');
  assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, '');
  assert.equal(settings.env.OTHER_OPTION, 'preserve');
  assert.equal(settings.apiKeyHelper, undefined);
  assert.deepEqual(settings.hooks, originalValue.hooks);
  assert.deepEqual(settings.permissions, originalValue.permissions);
  assert.equal(settings.customPlugin, 'leave');
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, profile().model);
  assert.equal(settings.env.ANTHROPIC_SMALL_FAST_MODEL, profile().model);
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, profile().model);
  const backupText = fs.readFileSync(path.join(backupDir, `${applied.backupId}.encrypted.json`), 'utf8');
  assert.equal(backupText.includes('fixture-original-secret'), false);
  assert.equal(adapter.listBackups()[0].canRestore, true);
  await adapter.applySubscription();
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), originalValue);
}));

test('subscription restores the first baseline after multiple API changes and does not promise membership for an old API baseline', async () => fixture(async dir => {
  const module = loadAdapter();
  const original = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-original-api' }, apiKeyHelper: 'old-helper', keep: 'original' }, null, 4);
  const { settingsPath, adapter } = createAdapter(module, dir, original);
  await adapter.apply(profile());
  await adapter.apply(profile({ model: 'second-model' }));
  const preview = await adapter.previewSubscription();
  assert.match(preview.warnings.join(' '), /不能保证/);
  await adapter.applySubscription();
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
}));

test('rolling back the latest API change retains the original baseline for a later subscription restoration', async () => fixture(async dir => {
  const module = loadAdapter();
  const original = JSON.stringify({ keep: true });
  const { settingsPath, adapter } = createAdapter(module, dir, original);
  await adapter.apply(profile());
  const second = await adapter.apply(profile({ model: 'second-model' }));
  await adapter.restore(second.backupId);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env.ANTHROPIC_MODEL, profile().model);
  await adapter.applySubscription();
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
}));

test('same-hash restore and apply guard protects settings edited outside the manager', async () => fixture(async dir => {
  const module = loadAdapter();
  const { settingsPath, adapter } = createAdapter(module, dir, JSON.stringify({ keep: true }));
  const applied = await adapter.apply(profile());
  const edited = { ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')), customNewSetting: 'keep' };
  fs.writeFileSync(settingsPath, JSON.stringify(edited));
  await assert.rejects(() => adapter.applySubscription(), /接管后被修改/);
  await assert.rejects(() => adapter.restore(applied.backupId), /接管后被修改/);
  await assert.rejects(() => adapter.apply(profile({ model: 'changed' })), /接管后被修改/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), edited);
  assert.equal(adapter.listBackups()[0].canRestore, false);
}));

test('without ownership the manager preserves an external route and reports membership as unconfirmed', async () => fixture(async dir => {
  const module = loadAdapter();
  const original = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:42000/other-tool', ANTHROPIC_AUTH_TOKEN: 'other-tool-token' }, apiKeyHelper: 'external-helper' });
  const { settingsPath, adapter } = createAdapter(module, dir, original);
  const preview = await adapter.previewSubscription();
  assert.equal(preview.changed, false);
  assert.match(preview.warnings.join(' '), /不能保证会员/);
  await adapter.applySubscription();
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
}));

test('a previously absent config becomes absent again, and unavailable encryption refuses an unsafe backup', async () => fixture(async dir => {
  const module = loadAdapter();
  const { settingsPath, adapter } = createAdapter(module, dir);
  await adapter.apply(profile());
  assert.equal(fs.existsSync(settingsPath), true);
  await adapter.applySubscription();
  assert.equal(fs.existsSync(settingsPath), false);
  module.setEncryptionAvailable(false);
  await assert.rejects(() => adapter.apply(profile()), /加密存储不可用/);
  assert.equal(fs.existsSync(settingsPath), false);
}));

test('Claude adapter rejects credential-file paths, malformed settings and non-manager gateway URLs', async () => fixture(async dir => {
  const module = loadAdapter();
  assert.throws(() => new module.ClaudeDesktopAdapter({ settingsPath: path.join(dir, '.credentials.json'), backupDir: path.join(dir, 'backups') }), /登录凭据/);
  const { settingsPath, adapter } = createAdapter(module, dir, JSON.stringify({ keep: true }));
  await assert.rejects(() => adapter.preview(profile({ gatewayBaseUrl: 'https://remote.example/claude' })), /本机网关/);
  await assert.rejects(() => adapter.preview(profile({ gatewayBaseUrl: 'http://127.0.0.1:41915/claudeevil' })), /本机网关/);
  fs.writeFileSync(settingsPath, '{invalid JSON containing a fake secret');
  await assert.rejects(() => adapter.apply(profile()), /不是有效 JSON/);
  assert.equal(adapter.listBackups().length, 0);
}));

test('VS Code settings snippet contains only the manager local route/token and pins each model slot', () => {
  const module = loadAdapter();
  const snippet = module.buildClaudeVSCodeSettings(profile());
  const entries = snippet['claudeCode.environmentVariables'];
  assert.equal(entries.find(item => item.name === 'ANTHROPIC_BASE_URL').value, profile().gatewayBaseUrl);
  assert.equal(entries.find(item => item.name === 'ANTHROPIC_AUTH_TOKEN').value, profile().gatewayToken);
  assert.equal(entries.find(item => item.name === 'ANTHROPIC_API_KEY').value, '');
  assert.equal(entries.find(item => item.name === 'ANTHROPIC_CUSTOM_HEADERS').value, '');
  assert.equal(entries.find(item => item.name === 'ANTHROPIC_DEFAULT_HAIKU_MODEL').value, profile().model);
});

test('Claude preview explicitly identifies CLI settings as separate from Claude desktop inference', async () => fixture(async dir => {
  const module = loadAdapter();
  const { adapter } = createAdapter(module, dir, '{}');
  const preview = await adapter.preview(profile());
  assert.match(preview.warnings.join(' '), /桌面版.*独立第三方推理配置/);
  assert.match(preview.warnings.join(' '), /不会切换 Claude 桌面版/);
}));
