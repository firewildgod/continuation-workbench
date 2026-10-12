const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const TOML = require('@iarna/toml');
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');

function loadAdapter() {
  const filename = path.resolve(__dirname, '../src/main/codex-desktop.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const adapterModule = new Module(filename, module);
  adapterModule.filename = filename;
  adapterModule.paths = Module._nodeModulePaths(path.dirname(filename));
  adapterModule._compile(compiled, filename);
  return adapterModule.exports;
}

function fixtureCipher() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
async function fixture(t, content = '') {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-config-test-'));
  const configPath = path.join(directory, 'codex', 'config.toml');
  await fsp.mkdir(path.dirname(configPath));
  await fsp.writeFile(configPath, content);
  const backupDir = path.join(directory, 'backups');
  const catalogDir = path.join(directory, 'catalogs');
  const cipher = fixtureCipher();
  const { CodexDesktopAdapter } = loadAdapter();
  const adapter = new CodexDesktopAdapter({ configPath, backupDir, catalogDir, cipher });
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('workbench-config-test-'));
    await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { adapter, configPath, backupDir, catalogDir, cipher };
}

const gateway = {
  baseUrl: 'http://127.0.0.1:19842/codex/v1', relayToken: 'local-relay-test-secret',
  model: 'continuation-active', catalogKind: 'generic',
};
const original = `# Existing user settings and comments\nmodel = "existing-model"\nmodel_provider = "original_vendor"\nweb_search = "cached"\nmodel_catalog_json = 'C:\\original\\models.json'\napproval_policy = "on-request"\n\n[features]\ncustom_feature = true\n\n[model_providers.original_vendor]\nname = "Original vendor"\nbase_url = "https://example.test/v1"\nhttp_headers = { Authorization = "Bearer fixture-cloud-secret", "X-API-Key" = "fixture-second-secret" }\n\n[projects.'C:\\project with spaces']\ntrust_level = "trusted"\n`;

test('preview preserves existing settings, masks credentials, and causes no writes', async t => {
  const { adapter, configPath, backupDir } = await fixture(t, original);
  const preview = await adapter.previewGateway(gateway);
  assert.equal(await fsp.readFile(configPath, 'utf8'), original);
  assert.equal(fs.existsSync(backupDir), false);
  for (const secret of ['fixture-cloud-secret', 'fixture-second-secret', gateway.relayToken]) {
    assert.equal(JSON.stringify(preview).includes(secret), false);
  }
  assert.equal(preview.targetProvider, 'continuation_workbench');
  assert.equal(preview.restartRequired, true);
});

test('apply encrypts original configuration, preserves unrelated TOML, and rollback restores exact bytes', async t => {
  const { adapter, configPath, backupDir } = await fixture(t, original);
  const preview = await adapter.previewGateway(gateway);
  const result = await adapter.apply(preview.previewId);
  const current = TOML.parse(await fsp.readFile(configPath, 'utf8'));
  const before = TOML.parse(original);
  assert.deepEqual(current.features, before.features);
  assert.deepEqual(current.projects, before.projects);
  assert.deepEqual(current.model_providers.original_vendor, before.model_providers.original_vendor);
  assert.equal(current.approval_policy, before.approval_policy);
  assert.equal(current.model_provider, 'continuation_workbench');
  assert.equal(current.model_providers.continuation_workbench.base_url, gateway.baseUrl);
  for (const file of await fsp.readdir(backupDir)) {
    const bytes = await fsp.readFile(path.join(backupDir, file));
    assert.equal(bytes.includes(Buffer.from('fixture-cloud-secret')), false);
  }
  assert.equal((await adapter.listBackups())[0].canRestore, true);
  await adapter.rollback(result.backupId);
  assert.equal(await fsp.readFile(configPath, 'utf8'), original);
});

test('original-route restore uses first baseline after multiple API configurations', async t => {
  const { adapter, configPath } = await fixture(t, original);
  await adapter.apply((await adapter.previewGateway(gateway)).previewId);
  await adapter.apply((await adapter.previewGateway({ ...gateway, model: 'second-model', catalogKind: 'deepseek' })).previewId);
  const restore = await adapter.previewSubscription();
  assert.equal(restore.label, '恢复首次接管前的原配置');
  assert.equal(restore.targetProvider, 'original_vendor');
  await adapter.apply(restore.previewId);
  const current = TOML.parse(await fsp.readFile(configPath, 'utf8'));
  const before = TOML.parse(original);
  for (const field of ['model', 'model_provider', 'model_catalog_json', 'web_search']) assert.equal(current[field], before[field]);
  assert.deepEqual(current.features, before.features);
});

test('stale previews and later manual changes cannot be overwritten or rolled back', async t => {
  const { adapter, configPath } = await fixture(t, original);
  const stale = await adapter.previewGateway(gateway);
  await fsp.appendFile(configPath, '\n# Changed externally\n');
  await assert.rejects(adapter.apply(stale.previewId), /发生了变化/);
  const applied = await adapter.apply((await adapter.previewGateway(gateway)).previewId);
  await fsp.appendFile(configPath, '\n# Changed after apply\n');
  await assert.rejects(adapter.rollback(applied.backupId), /再次修改/);
  assert.equal((await adapter.listBackups()).find(item => item.id === applied.backupId).canRestore, false);
});

test('invalid TOML and unavailable encryption leave the original file unchanged', async t => {
  const bad = await fixture(t, 'model = [ broken');
  await assert.rejects(bad.adapter.previewGateway(gateway), /有效 TOML/);
  assert.equal(await fsp.readFile(bad.configPath, 'utf8'), 'model = [ broken');
  const good = await fixture(t, original);
  const { CodexDesktopAdapter } = loadAdapter();
  const unavailable = new CodexDesktopAdapter({ configPath: good.configPath,
    backupDir: good.backupDir, catalogDir: good.catalogDir,
    cipher: { ...good.cipher, isEncryptionAvailable: () => false } });
  await assert.rejects(unavailable.apply((await unavailable.previewGateway(gateway)).previewId), /系统加密不可用/);
  assert.equal(await fsp.readFile(good.configPath, 'utf8'), original);
});

test('exact model IDs preserve verified vision/context while unknown models remain conservative', async t => {
  const { adapter } = await fixture(t);
  const cases = [
    { model: 'qwen3.8-flash', kind: 'generic', image: true, context: 1000000, percent: 80, levels: ['none','low','medium','xhigh'] },
    { model: 'qwen3.8-max', kind: 'generic', image: true, context: 1000000, percent: 80, levels: ['none','low','medium','xhigh'] },
    { model: 'qwen3.8-max-0902', kind: 'generic', image: true, context: 1000000, percent: 80, levels: ['none','low','medium','xhigh'] },
    { model: 'qwen3.8-max-2026-09-02', kind: 'generic', image: true, context: 1000000, percent: 80, levels: ['none','low','medium','xhigh'] },
    { model: 'deepseek-flash', kind: 'deepseek', image: true, context: 1048576, percent: 95, levels: ['none','low','high','max'] },
    { model: 'deepseek-v4-pro', kind: 'deepseek', image: false, context: 1048576, percent: 95, levels: ['none','low','high','max'] },
    { model: 'deepseek-v4.1-flash', kind: 'generic', image: true, context: 1000000, percent: 80, levels: ['none','low','high','max'] },
    { model: 'deepseek-v4-pro', kind: 'generic', image: false, context: 1000000, percent: 80, levels: ['none','high','max'] },
    { model: 'unknown-model', kind: 'generic', image: false, context: 32768, percent: 95, levels: [] },
    { model: 'deepseek-future-vision', kind: 'deepseek', image: false, context: 32768, percent: 95, levels: [] },
    { model: 'qwen3.8-flash-unverified', kind: 'generic', image: false, context: 32768, percent: 95, levels: [] },
  ];
  for (const item of cases) {
    const preview=await adapter.previewGateway({...gateway,model:item.model,catalogKind:item.kind});
    const result=await adapter.apply(preview.previewId);
    const catalog=JSON.parse(await fsp.readFile(result.catalogPath,'utf8')).models[0];
    assert.deepEqual(catalog.input_modalities,item.image?['text','image']:['text'],item.model);
    assert.equal(catalog.context_window,item.context,item.model);
    assert.equal(catalog.max_context_window,item.context,item.model);
    assert.equal(catalog.effective_context_window_percent,item.percent,item.model);
    assert.equal(catalog.supports_image_detail_original,item.image,item.model);
    assert.deepEqual(catalog.supported_reasoning_levels.map(level=>level.effort),item.levels,item.model);
    const direct=item.kind==='deepseek'&&['deepseek-flash','deepseek-v4-pro'].includes(item.model);
    assert.equal(catalog.supports_parallel_tool_calls,direct,item.model);
    assert.equal(catalog.support_verbosity,direct,item.model);
    assert.equal(catalog.apply_patch_tool_type,direct?'freeform':null,item.model);
    assert.match(preview.warnings.join(' '),item.context===32768?/32K/:/精确模型 ID/,item.model);
  }
});

test('reapplying a legacy model catalog uses a revised path so capability fixes reach existing routes',async t=>{
  const {adapter,configPath,catalogDir}=await fixture(t);
  const oldHash=crypto.createHash('sha256').update('qwen3.8-flash\ngeneric').digest('hex').slice(0,16);
  const oldPath=path.join(catalogDir,`codex-${oldHash}.json`);
  const legacy={model:'qwen3.8-flash',model_provider:'continuation_workbench',model_catalog_json:oldPath,web_search:'disabled',model_providers:{continuation_workbench:{name:'续航台本机 API 网关',base_url:gateway.baseUrl,wire_api:'responses',requires_openai_auth:false,supports_websockets:false,http_headers:{Authorization:`Bearer ${gateway.relayToken}`}}}};
  await fsp.writeFile(configPath,TOML.stringify(legacy));
  const preview=await adapter.previewGateway({...gateway,model:'qwen3.8-flash'});
  assert.equal(preview.changed,true);
  const applied=await adapter.apply(preview.previewId);assert.notEqual(applied.catalogPath,oldPath);
  const catalog=JSON.parse(await fsp.readFile(applied.catalogPath,'utf8')).models[0];assert.deepEqual(catalog.input_modalities,['text','image']);
});

function installedCodex() {
  if (process.env.CODEX_TEST_EXECUTABLE) return process.env.CODEX_TEST_EXECUTABLE;
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(command, ['codex'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)
      .map(line => line.trim()).find(line => line && (process.platform !== 'win32' || line.endsWith('.exe'))) || '';
  } catch { return ''; }
}
const codexExecutable = installedCodex();

test('installed official Codex parses generated conservative, Qwen and DeepSeek catalogs offline', {
  skip: !fs.existsSync(codexExecutable), timeout: 40_000,
}, async t => {
  const { adapter, configPath } = await fixture(t);
  for (const [kind,model] of [['generic','offline-catalog-generic'],['generic','qwen3.8-flash'],['deepseek','deepseek-flash'],['deepseek','deepseek-v4-pro'],['generic','deepseek-v4.1-flash']]) {
    const preview = await adapter.previewGateway({ ...gateway, model, catalogKind: kind });
    await adapter.apply(preview.previewId);
    const environment = { ...process.env, CODEX_HOME: path.dirname(configPath) };
    for (const key of ['CODEX_SQLITE_HOME', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY',
      'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE']) delete environment[key];
    const child = spawn(codexExecutable, ['app-server', '--listen', 'stdio://'], {
      cwd: path.dirname(configPath), env: environment, windowsHide: true, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const pending = new Map();
    let id = 0;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString().replaceAll(gateway.relayToken, '[hidden]'); });
    lines.on('line', line => {
      let response; try { response = JSON.parse(line); } catch { return; }
      if (!response.method && pending.has(response.id)) {
        const request = pending.get(response.id); pending.delete(response.id); clearTimeout(request.timer);
        if (response.error) request.reject(new Error(response.error.message)); else request.resolve(response.result);
      }
    });
    const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
    child.on('error', error => {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear();
    });
    child.on('exit', code => {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Codex exit ${code}: ${stderr}`)); }
      pending.clear();
    });
    const request = (method, params = {}) => new Promise((resolveRequest, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`RPC timeout: ${method}`)); }, 15_000);
      pending.set(requestId, { resolve: resolveRequest, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id: requestId, params })}\n`);
    });
    try {
      await request('initialize', { clientInfo: { name: 'workbench_fixture', title: 'Offline config fixture', version: '0.1.0' } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      const account = await request('account/read', { refreshToken: false });
      assert.equal(account.requiresOpenaiAuth, false);
      const models = await request('model/list', { limit: 20 });
      assert.ok(models.data.some(item => item.model === model || item.id === model));
    } finally {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2_000);
      await closed;
      clearTimeout(timer);
      lines.close();
    }
  }
});
