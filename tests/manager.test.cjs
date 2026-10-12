const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const vm = require('node:vm');
const ts = require('typescript');
const TOML = require('@iarna/toml');

function encryptionBoundary() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function loadManager(fixtureRoot, options = {}) {
  const cache = new Map();
  const safeStorage = encryptionBoundary();
  const guardedPath = (filename, allowAncestor = false) => {
    const absolute = path.resolve(String(filename));
    const relative = path.relative(fixtureRoot, absolute);
    const ancestor = path.relative(absolute, fixtureRoot);
    const inside = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    const isAncestor = ancestor !== '..' && !ancestor.startsWith(`..${path.sep}`) && !path.isAbsolute(ancestor);
    assert.ok(inside || allowAncestor && isAncestor,
      `application attempted to access a path outside its fixture: ${filename}`);
  };
  const syncFs = { ...fs };
  for (const method of ['existsSync', 'readFileSync', 'writeFileSync', 'statSync', 'lstatSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'readdirSync']) {
    syncFs[method] = (filename, ...args) => { guardedPath(filename,['existsSync','statSync','lstatSync'].includes(method)); return fs[method](filename, ...args); };
  }
  syncFs.renameSync = (from, to) => { guardedPath(from); guardedPath(to); return fs.renameSync(from, to); };
  const asyncFs = { ...fsp };
  for (const method of ['readFile', 'writeFile', 'appendFile', 'lstat', 'stat', 'mkdir', 'rm', 'readdir']) {
    asyncFs[method] = (filename, ...args) => { guardedPath(filename); return fsp[method](filename, ...args); };
  }
  asyncFs.rename = (from, to) => { guardedPath(from); guardedPath(to); return fsp.rename(from, to); };
  syncFs.promises = asyncFs;
  const sourceRoot = path.resolve(__dirname, '../src/main');
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const unit = { exports: {} };
    cache.set(filename, unit);
    const source = fs.readFileSync(filename, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const localRequire = name => {
      if (name === 'electron') return { safeStorage };
      if (name === 'node:fs') return syncFs;
      if (name === 'node:fs/promises') return asyncFs;
      if (name === './detection') return {
        // Verify the explicit fixture guard rather than bypassing mutationGuard.
        detectDesktops: async () => ({ codexPath: '', codexRunning: true, claudeRunning: false, claudeDesktopPath: '', claudeDesktopRunning: false, ...options.detection }),
        launchCodexDesktop: async () => { throw new Error('Unexpected desktop launch in fixture'); },
        launchClaudeTerminal: async () => { throw new Error('Unexpected terminal launch in fixture'); },
        launchClaudeGui: async () => { throw new Error('Unexpected Claude desktop launch in fixture'); },
      };
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), `${name}.ts`));
      return require(name);
    };
    vm.runInNewContext(compiled, {
      module: unit, exports: unit.exports, require: localRequire,
      Buffer, URL, structuredClone, AbortSignal, AbortController, setTimeout, clearTimeout,
      process: { env: { ...process.env, WORKBENCH_TEST_DATA: fixtureRoot }, platform: process.platform },
      fetch: options.fetch || (async () => { throw new Error('Unexpected upstream inference in manager fixture'); }),
    }, { filename });
    return unit.exports;
  }
  return load(path.join(sourceRoot, 'manager.ts'));
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(t, options = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-manager-test-'));
  const configPath = path.join(directory, 'official-codex', 'config.toml');
  const claudePath = path.join(directory, 'official-claude', 'settings.json');
  const claudeDesktopConfigDir = path.join(directory, 'fixtures', 'Claude-3p', 'configLibrary');
  await fsp.mkdir(path.dirname(configPath));
  await fsp.mkdir(path.dirname(claudePath));
  await fsp.writeFile(configPath, 'model_provider = "openai"\nmodel = "original-official-model"\n');
  await fsp.writeFile(claudePath, '{}');
  await fsp.writeFile(path.join(directory, 'gateway.local.json'), JSON.stringify({ port: await unusedPort(), encryptedToken: '', routes: {} }));
  const { ConnectionManager } = loadManager(directory, options);
  const manager = new ConnectionManager(directory);
  const managers = [manager];
  manager.services.saveSettings({ codexConfigPath: configPath, claudeConfigPath: claudePath, claudeDesktopConfigDir });
  await manager.start();
  t.after(async () => {
    for(const instance of managers) {await instance.gateway.stop();await instance.usage.flush();}
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('workbench-manager-test-'));
    await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, manager, configPath, claudePath, claudeDesktopConfigDir, ConnectionManager, trackManager: instance=>managers.push(instance) };
}
function connection(overrides = {}) {
  return { name: 'Fixture API A', presetId: 'openai', engine: 'codex', protocol: 'responses',
    baseUrl: 'https://offline-upstream.invalid/v1', model: 'fixture-model-a',
    apiKey: 'fixture-api-key-never-sent', ...overrides };
}
async function applyApi(manager, connectionId) {
  const input = { engine: 'codex', mode: 'api', connectionId };
  await manager.previewToolConfig(input);
  return manager.applyToolConfig(input);
}

test('changing a same-ID connection or key after preview rejects apply and preserves official fixture', async t => {
  const { manager, configPath } = await fixture(t);
  const original = await fsp.readFile(configPath, 'utf8');
  const saved = manager.services.saveConnection(connection());
  const input = { engine: 'codex', mode: 'api', connectionId: saved.id };
  await manager.previewToolConfig(input);
  manager.services.saveConnection(connection({ id: saved.id, model: 'changed-model' }));
  await assert.rejects(manager.applyToolConfig(input), /重新预览/);
  assert.equal(await fsp.readFile(configPath, 'utf8'), original);
  await manager.previewToolConfig(input);
  manager.services.saveConnection(connection({ id: saved.id, model: 'changed-model', apiKey: 'changed-fixture-api-key' }));
  await assert.rejects(manager.applyToolConfig(input), /重新预览/);
  assert.equal(await fsp.readFile(configPath, 'utf8'), original);
});

test('API A to API B config rollback restores both the config model and gateway route A', async t => {
  const { manager, configPath, directory } = await fixture(t);
  const apiA = manager.services.saveConnection(connection());
  const apiB = manager.services.saveConnection(connection({ name: 'Fixture API B', model: 'fixture-model-b', apiKey: 'fixture-api-key-b' }));
  await applyApi(manager, apiA.id);
  assert.equal(manager.gateway.status().routes.codex, apiA.id);
  const resultB = await applyApi(manager, apiB.id);
  assert.equal(manager.gateway.status().routes.codex, apiB.id);
  assert.equal(TOML.parse(await fsp.readFile(configPath, 'utf8')).model, 'fixture-model-b');
  await manager.restoreConfigBackup(resultB.backupId);
  assert.equal(manager.gateway.status().routes.codex, apiA.id);
  assert.equal(TOML.parse(await fsp.readFile(configPath, 'utf8')).model, 'fixture-model-a');
  assert.equal(JSON.parse(await fsp.readFile(path.join(directory, 'gateway.local.json'), 'utf8')).routes.codex, apiA.id);
  assert.equal(manager.gateway.status().requestCounts.codex, 0, 'fixture must not make an inference call');
});

test('backup restore clears forwarding when the original API connection no longer exists', async t => {
  const { manager, configPath } = await fixture(t);
  const apiA = manager.services.saveConnection(connection());
  const apiB = manager.services.saveConnection(connection({ name: 'Fixture API B', model: 'fixture-model-b', apiKey: 'fixture-api-key-b' }));
  await applyApi(manager, apiA.id);
  const resultB = await applyApi(manager, apiB.id);
  manager.services.deleteConnection(apiA.id);
  const restored = await manager.restoreConfigBackup(resultB.backupId);
  assert.equal(manager.gateway.status().routes.codex, undefined);
  assert.equal(TOML.parse(await fsp.readFile(configPath, 'utf8')).model, 'fixture-model-a');
  assert.match(restored.message, /原连接无法确认/);
});

test('state and preview read only explicit fixture config paths and expose no vendor key', async t => {
  const { manager, configPath } = await fixture(t);
  const saved = manager.services.saveConnection(connection());
  const state = await manager.state();
  assert.equal(state.companion.tools.find(item => item.engine === 'codex').configPath, configPath);
  assert.equal(state.companion.tools.find(item => item.engine === 'codex').running, true);
  assert.equal(JSON.stringify(state).includes(connection().apiKey), false);
  const preview = await manager.previewToolConfig({ engine: 'codex', mode: 'api', connectionId: saved.id });
  assert.equal(JSON.stringify(preview).includes(connection().apiKey), false);
});

function claudeConnection(overrides = {}) {
  return connection({name:'Fixture Claude API',presetId:'custom',engine:'claude',protocol:'anthropic',baseUrl:'https://offline-upstream.invalid/anthropic',model:'claude-sonnet-4-6',apiKey:'fixture-claude-provider-key-never-sent',...overrides});
}
async function applyClaudeCli(manager,connectionId) {
  const input={engine:'claude',mode:'api',connectionId};
  await manager.previewToolConfig(input);return manager.applyToolConfig(input);
}
async function applyClaudeGui(manager,connectionId) {
  const input={mode:'api',connectionId};
  await manager.previewClaudeDesktopConfig(input);return manager.applyClaudeDesktopConfig(input);
}
async function desktopFiles(f) {
  const profile=(await f.manager.getClaudeDesktopState()).configPath;
  return {profile,meta:path.join(f.claudeDesktopConfigDir,'_meta.json'),mode:path.join(path.dirname(f.claudeDesktopConfigDir),'claude_desktop_config.json')};
}

test('Claude desktop preview and apply configure automatic 3P mode without vendor keys or CLI/Codex changes',async t=>{
  const f=await fixture(t),beforeCodex=await fsp.readFile(f.configPath,'utf8'),beforeCli=await fsp.readFile(f.claudePath,'utf8');
  const saved=f.manager.services.saveConnection(claudeConnection());
  const input={mode:'api',connectionId:saved.id},files=await desktopFiles(f);
  const preview=await f.manager.previewClaudeDesktopConfig(input);
  assert.equal(preview.surface,'desktop');assert.equal(preview.activationKind,'auto');assert.equal(preview.configPath,files.profile);assert.equal(preview.changed,true);
  assert.equal(fs.existsSync(files.profile),false);assert.equal(fs.existsSync(files.mode),false);
  assert.doesNotMatch(JSON.stringify(preview),/fixture-claude-provider-key-never-sent/);
  const result=await f.manager.applyClaudeDesktopConfig(input);assert.equal(result.ok,true);assert.equal(result.activationState,'configured');assert.ok(result.backupId);
  const profile=JSON.parse(await fsp.readFile(files.profile,'utf8')),meta=JSON.parse(await fsp.readFile(files.meta,'utf8')),mode=JSON.parse(await fsp.readFile(files.mode,'utf8'));
  assert.equal(profile.inferenceProvider,'gateway');assert.equal(profile.inferenceGatewayBaseUrl,f.manager.gateway.status().baseUrl+'/claude-desktop');assert.equal(profile.inferenceGatewayAuthScheme,'bearer');
  assert.equal(profile.inferenceModels[0].name,saved.model);assert.equal(profile.inferenceGatewayApiKey.length,64);assert.equal(mode.deploymentMode,'3p');assert.equal(meta.appliedId,path.basename(files.profile,'.json'));
  assert.doesNotMatch(JSON.stringify(profile),/fixture-claude-provider-key-never-sent|offline-upstream\.invalid/);
  assert.equal(await fsp.readFile(f.configPath,'utf8'),beforeCodex);assert.equal(await fsp.readFile(f.claudePath,'utf8'),beforeCli);
  const status=await f.manager.getClaudeDesktopState();assert.equal(status.mode,'api');assert.equal(status.activationState,'configured');assert.equal(status.activeConnectionId,saved.id);assert.equal(status.requestCount,0);
  assert.equal(f.manager.gateway.status().routes.claudeDesktop,saved.id);assert.equal(f.manager.gateway.status().routes.claude,undefined);assert.equal(f.manager.gateway.status().requestCounts.claude,0);
  assert.doesNotMatch(JSON.stringify(await f.manager.state()),/fixture-claude-provider-key-never-sent/);
});

test('Claude desktop route and encrypted ownership persist independently from CLI and Codex after manager restart',async t=>{
  const f=await fixture(t);
  const codex=f.manager.services.saveConnection(connection()),cli=f.manager.services.saveConnection(claudeConnection()),desktop=f.manager.services.saveConnection(claudeConnection({name:'Desktop API',model:'claude-opus-4-6',apiKey:'fixture-desktop-key'}));
  await applyApi(f.manager,codex.id);await applyClaudeCli(f.manager,cli.id);await applyClaudeGui(f.manager,desktop.id);
  const expected={codex:codex.id,claude:cli.id,claudeDesktop:desktop.id};
  assert.deepEqual({...f.manager.gateway.status().routes},expected);
  const relay=JSON.parse(await fsp.readFile(path.join(f.directory,'gateway.local.json'),'utf8'));assert.deepEqual(relay.routes,expected);assert.ok(relay.encryptedToken);assert.doesNotMatch(JSON.stringify(relay),/fixture-desktop-key|fixture-claude-provider-key/);
  await f.manager.gateway.stop();await f.manager.usage.flush();
  const restarted=new f.ConnectionManager(f.directory);f.trackManager(restarted);await restarted.start();
  assert.deepEqual({...restarted.gateway.status().routes},expected);
  const gui=await restarted.getClaudeDesktopState();assert.equal(gui.mode,'api');assert.equal(gui.activationState,'configured');assert.equal(gui.activeConnectionId,desktop.id);assert.equal(gui.model,'claude-opus-4-6');
  const tools=await restarted.getToolState();assert.equal(tools.tools.find(item=>item.engine==='claude').activeConnectionId,cli.id);assert.equal(tools.tools.find(item=>item.engine==='codex').activeConnectionId,codex.id);
  assert.equal(restarted.gateway.status().desktopSuccessCount,0,'restart cannot assert a desktop request was verified');
});

test('Claude desktop baseline and latest backup restore corresponding desktop routes while preserving CLI bytes',async t=>{
  const f=await fixture(t),files=await desktopFiles(f);
  await fsp.mkdir(f.claudeDesktopConfigDir,{recursive:true});
  const beforeMode='{\n  "deploymentMode": "1p",\n  "theme": "fixture-original-theme"\n}\n';
  const beforeMeta='{"appliedId":"","entries":[],"fixtureCustom":"keep-this-index-field"}\n';
  await fsp.writeFile(files.mode,beforeMode);await fsp.writeFile(files.meta,beforeMeta);
  const cli=f.manager.services.saveConnection(claudeConnection({name:'CLI API'})),a=f.manager.services.saveConnection(claudeConnection({name:'Desktop A',model:'claude-sonnet-4-6'})),b=f.manager.services.saveConnection(claudeConnection({name:'Desktop B',model:'claude-opus-4-6',apiKey:'fixture-b-key'}));
  await applyClaudeCli(f.manager,cli.id);const cliBytes=await fsp.readFile(f.claudePath,'utf8'),codexBytes=await fsp.readFile(f.configPath,'utf8');
  const appliedA=await applyClaudeGui(f.manager,a.id),appliedB=await applyClaudeGui(f.manager,b.id);assert.notEqual(appliedA.backupId,appliedB.backupId);
  assert.equal(f.manager.gateway.status().routes.claudeDesktop,b.id);
  const backupState=JSON.parse(await fsp.readFile(path.join(f.directory,'backup-routes.json'),'utf8'));assert.equal(backupState[appliedB.backupId].surface,'desktop');assert.equal(backupState[appliedB.backupId].route,a.id);
  await f.manager.restoreClaudeDesktopConfigBackup();
  assert.equal(f.manager.gateway.status().routes.claudeDesktop,a.id);assert.equal(JSON.parse(await fsp.readFile(files.profile,'utf8')).inferenceModels[0].name,'claude-sonnet-4-6');
  assert.equal(f.manager.gateway.status().routes.claude,cli.id);assert.equal(await fsp.readFile(f.claudePath,'utf8'),cliBytes);assert.equal(await fsp.readFile(f.configPath,'utf8'),codexBytes);
  await f.manager.previewClaudeDesktopConfig({mode:'subscription'});await f.manager.applyClaudeDesktopConfig({mode:'subscription'});
  assert.equal(fs.existsSync(files.profile),false);assert.equal(await fsp.readFile(files.mode,'utf8'),beforeMode);assert.equal(await fsp.readFile(files.meta,'utf8'),beforeMeta);assert.equal(f.manager.gateway.status().routes.claudeDesktop,undefined);
  assert.equal(f.manager.gateway.status().routes.claude,cli.id);assert.equal(await fsp.readFile(f.claudePath,'utf8'),cliBytes);
  const backups=(await f.manager.getClaudeDesktopState()).backups;const baselineUndo=backups.find(item=>item.canRestore);
  assert.ok(baselineUndo);await f.manager.restoreClaudeDesktopConfigBackup(baselineUndo.id);
  assert.equal(f.manager.gateway.status().routes.claudeDesktop,a.id);assert.equal(JSON.parse(await fsp.readFile(files.profile,'utf8')).inferenceModels[0].name,'claude-sonnet-4-6');assert.equal(f.manager.gateway.status().routes.claude,cli.id);
});

test('Claude desktop refuses changed keys, models or config schema after preview without writing',async t=>{
  const f=await fixture(t),files=await desktopFiles(f),saved=f.manager.services.saveConnection(claudeConnection());
  const input={mode:'api',connectionId:saved.id};
  await f.manager.previewClaudeDesktopConfig(input);f.manager.services.saveConnection(claudeConnection({id:saved.id,apiKey:'changed-fixture-provider-key'}));
  await assert.rejects(f.manager.applyClaudeDesktopConfig(input),/重新预览/);assert.equal(fs.existsSync(files.profile),false);
  await f.manager.previewClaudeDesktopConfig(input);f.manager.services.saveConnection(claudeConnection({id:saved.id,model:'claude-opus-4-6',apiKey:'changed-fixture-provider-key'}));
  await assert.rejects(f.manager.applyClaudeDesktopConfig(input),/重新预览/);assert.equal(fs.existsSync(files.profile),false);
  await f.manager.previewClaudeDesktopConfig(input);await fsp.mkdir(f.claudeDesktopConfigDir,{recursive:true});await fsp.writeFile(files.meta,'{"appliedId":"unexpected-schema","entries":[]}');
  await assert.rejects(f.manager.applyClaudeDesktopConfig(input),/重新预览/);assert.equal(fs.existsSync(files.profile),false);assert.equal(await fsp.readFile(files.meta,'utf8'),'{"appliedId":"unexpected-schema","entries":[]}');assert.equal(f.manager.gateway.status().routes.claudeDesktop,undefined);
});

test('active desktop request blocks only its own config while CLI can switch and desktop usage stays in the shared ledger',async t=>{
  let resolveUpstream,arrived;const ready=new Promise(resolve=>arrived=resolve);
  const f=await fixture(t,{fetch:(url,options)=>{
    assert.equal(url,'https://offline-upstream.invalid/anthropic/v1/messages');
    const body=JSON.parse(options.body);assert.equal(body.model,'claude-sonnet-4-6');
    arrived();return new Promise((resolve,reject)=>{resolveUpstream=()=>resolve(new Response('{"type":"message","model":"claude-sonnet-4-6","usage":{"input_tokens":2,"output_tokens":3}}',{status:200,headers:{'content-type':'application/json'}}));options.signal.addEventListener('abort',()=>reject(new Error('fixture cancelled')),{once:true});});
  }});
  const cliA=f.manager.services.saveConnection(claudeConnection({name:'CLI A'})),cliB=f.manager.services.saveConnection(claudeConnection({name:'CLI B',model:'claude-opus-4-6'})),desktop=f.manager.services.saveConnection(claudeConnection({name:'Desktop',model:'claude-sonnet-4-6'}));
  await applyClaudeCli(f.manager,cliA.id);await applyClaudeGui(f.manager,desktop.id);
  const files=await desktopFiles(f),profile=JSON.parse(await fsp.readFile(files.profile,'utf8'));
  const responseTask=fetch(f.manager.gateway.status().baseUrl+'/claude-desktop/v1/messages',{method:'POST',headers:{authorization:`Bearer ${profile.inferenceGatewayApiKey}`,'content-type':'application/json'},body:JSON.stringify({model:'client-alias',messages:[],max_tokens:1})});
  await ready;assert.equal(f.manager.gateway.activeRequestsFor('claudeDesktop'),1);assert.equal(f.manager.gateway.activeRequestsFor('claude'),0);
  await f.manager.previewClaudeDesktopConfig({mode:'api',connectionId:desktop.id});await assert.rejects(f.manager.applyClaudeDesktopConfig({mode:'api',connectionId:desktop.id}),/请求执行中/);
  await applyClaudeCli(f.manager,cliB.id);assert.equal(f.manager.gateway.status().routes.claude,cliB.id);assert.equal(f.manager.gateway.status().routes.claudeDesktop,desktop.id);
  resolveUpstream();await (await responseTask).text();await f.manager.usage.flush();
  const records=f.manager.usage.records();assert.equal(records.length,1);assert.equal(records[0].engine,'claude');assert.equal(records[0].surface,'desktop');assert.equal(records[0].model,'claude-sonnet-4-6');assert.equal(records[0].connectionId,desktop.id);
  const status=await f.manager.getClaudeDesktopState();assert.equal(status.activationState,'verified');assert.equal(status.requestCount,1);assert.ok(status.lastRequestAt);
  assert.doesNotMatch(JSON.stringify(records),/fixture-claude-provider-key|client-alias|messages/);
});

test('Claude desktop must be fully exited before applying configuration even in an isolated fixture',async t=>{
  const detection={claudeDesktopRunning:true};const f=await fixture(t,{detection}),saved=f.manager.services.saveConnection(claudeConnection()),files=await desktopFiles(f);
  const input={mode:'api',connectionId:saved.id};await f.manager.previewClaudeDesktopConfig(input);
  await assert.rejects(f.manager.applyClaudeDesktopConfig(input),/完全退出/);assert.equal(fs.existsSync(files.profile),false);assert.equal(f.manager.gateway.status().routes.claudeDesktop,undefined);
  detection.claudeDesktopRunning=false;
  await f.manager.previewClaudeDesktopConfig(input);const result=await f.manager.applyClaudeDesktopConfig(input);assert.equal(result.ok,true);assert.equal(f.manager.gateway.status().routes.claudeDesktop,saved.id);
});

test('non-Claude desktop models are rejected without creating GUI files or altering the working CLI route',async t=>{
  const f=await fixture(t),files=await desktopFiles(f),cli=f.manager.services.saveConnection(claudeConnection({model:'qwen3.8-flash'}));
  await applyClaudeCli(f.manager,cli.id);const cliBytes=await fsp.readFile(f.claudePath,'utf8'),codexBytes=await fsp.readFile(f.configPath,'utf8');
  for(const model of ['qwen3.8-flash','deepseek-v4.1-flash']) {
    const saved=f.manager.services.saveConnection(claudeConnection({name:`Rejected desktop ${model}`,model}));
    await assert.rejects(f.manager.previewClaudeDesktopConfig({mode:'api',connectionId:saved.id}),/Claude|claude|官方桌面/);
    await assert.rejects(f.manager.applyClaudeDesktopConfig({mode:'api',connectionId:saved.id}),/Claude|claude|桌面|预览/);
    assert.equal(fs.existsSync(files.profile),false);assert.equal(fs.existsSync(files.meta),false);assert.equal(fs.existsSync(files.mode),false);
    assert.equal(f.manager.gateway.status().routes.claudeDesktop,undefined);assert.equal(f.manager.gateway.status().routes.claude,cli.id);
    assert.equal(await fsp.readFile(f.claudePath,'utf8'),cliBytes);assert.equal(await fsp.readFile(f.configPath,'utf8'),codexBytes);
  }
});
