const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');

function loadServices(options = {}) {
  let encryptionAvailable = options.encryptionAvailable !== false;
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    // Mock only the OS boundary: no real account, credential or keychain is used.
    encryptString: value => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 83)),
    decryptString: value => Buffer.from([...value].map(byte => byte ^ 83)).toString(),
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'services.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const unit = { exports: {} };
  const usageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'usage.ts'), 'utf8');
  const usageCompiled = ts.transpileModule(usageSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const usageUnit = { exports: {} };
  vm.runInNewContext(usageCompiled, { module: usageUnit, exports: usageUnit.exports, require, Buffer, Date }, { filename: 'usage.ts' });
  const pricingSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'pricing.ts'), 'utf8');
  const pricingUnit = { exports: {} };
  const pricingCompiled = ts.transpileModule(pricingSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(pricingCompiled, { module: pricingUnit, exports: pricingUnit.exports, require, Buffer, Date, URL, AbortController, TextDecoder, setTimeout, clearTimeout, structuredClone }, { filename: 'pricing.ts' });
  vm.runInNewContext(compiled, {
    module: unit, exports: unit.exports,
    require: name => name === 'electron' ? { safeStorage } : name === './usage' ? usageUnit.exports : name === './pricing' ? pricingUnit.exports : require(name),
    Buffer, URL, structuredClone, AbortSignal,
    process: { env: { SystemRoot: 'C:\\Windows' } },
    fetch: options.fetch || (async () => { throw new Error('Unexpected network call in test'); }),
  }, { filename: 'services.ts' });
  return { ...unit.exports, setEncryptionAvailable: value => { encryptionAvailable = value; } };
}
async function fixture(run) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-services-'));
  const resolved = path.resolve(fixtureRoot);
  const tempRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), tempRoot);
  assert.equal(path.basename(resolved).startsWith('continuation-services-'), true);
  try { return await run(fixtureRoot); }
  finally {
    // Delete only the verified, newly created test folder, never a computed parent.
    if (path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith('continuation-services-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
function connectionInput(overrides = {}) {
  return { name: 'Fixture connection', presetId: 'anthropic', engine: 'claude', protocol: 'anthropic', model: 'fixture-model', baseUrl: 'https://fixture.example', apiKey: 'sk-test-redacted', ...overrides };
}

test('public connections and settings do not expose a vendor secret; a reload decrypts the own vault', async () => fixture(async dir => {
  const module = loadServices();
  const services = new module.WorkbenchServices(dir);
  const input = connectionInput();
  const connection = services.saveConnection(input);
  assert.equal(connection.hasKey, true);
  assert.equal(services.getSecret(connection.id), input.apiKey);
  assert.equal(JSON.stringify(services.getConnections()).includes(input.apiKey), false);
  assert.equal(fs.readFileSync(path.join(dir, 'workbench.json'), 'utf8').includes(input.apiKey), false);
  assert.equal(fs.readFileSync(path.join(dir, 'api-secrets.local.json'), 'utf8').includes(input.apiKey), false);
  const reloaded = new module.WorkbenchServices(dir);
  assert.equal(reloaded.getSecret(connection.id), input.apiKey);
  reloaded.saveConnection({ ...input, id: connection.id, apiKey: '' });
  assert.equal(reloaded.getSecret(connection.id), input.apiKey);
  reloaded.deleteConnection(connection.id);
  assert.equal(reloaded.getSecret(connection.id), undefined);
}));

test('unavailable encryption stores the API secret only for the current manager process', async () => fixture(async dir => {
  const module = loadServices({ encryptionAvailable: false });
  const services = new module.WorkbenchServices(dir);
  const input = connectionInput();
  const saved = services.saveConnection(input);
  assert.equal(services.getSecret(saved.id), input.apiKey);
  assert.match(saved.maskedKey, /仅本次运行/);
  assert.equal(fs.readFileSync(path.join(dir, 'api-secrets.local.json'), 'utf8').includes(input.apiKey), false);
  assert.equal(new module.WorkbenchServices(dir).getSecret(saved.id), undefined);
}));

test('connection validation rejects credential URLs, remote plaintext HTTP and model control characters', async () => fixture(async dir => {
  const module = loadServices();
  const services = new module.WorkbenchServices(dir);
  assert.throws(() => services.saveConnection(connectionInput({ baseUrl: 'https://key@fixture.example' })), /用户名/);
  assert.throws(() => services.saveConnection(connectionInput({ baseUrl: 'http://remote.example/v1' })), /HTTPS/);
  assert.throws(() => services.saveConnection(connectionInput({ model: 'x\ny' })), /无效/);
  assert.equal(module.validateApiBaseUrl('http://127.0.0.1:42000/v1/'), 'http://127.0.0.1:42000/v1');
  assert.equal(module.apiTestEndpoint('https://fixture.example/anthropic', 'anthropic'), 'https://fixture.example/anthropic/v1/messages');
  assert.equal(module.apiTestEndpoint('https://fixture.example/v1/', 'anthropic'), 'https://fixture.example/v1/messages');
}));

test('configured executable and new companion paths accept only absolute strings or an empty reset', async () => fixture(async dir => {
  const services = new (loadServices().WorkbenchServices)(dir);
  assert.equal(services.getSettings().monthlyBudgetCNY, 100);
  for (const field of ['codexPath', 'claudePath', 'codexDesktopPath', 'codexConfigPath', 'claudeConfigPath', 'claudeLaunchDirectory']) {
    assert.throws(() => services.saveSettings({ [field]: null }), /字符串/);
    assert.throws(() => services.saveSettings({ [field]: 42 }), /字符串/);
    assert.throws(() => services.saveSettings({ [field]: 'relative/path' }), /绝对路径/);
    assert.throws(() => services.saveSettings({ [field]: `${dir}\n` }), /控制字符/);
    assert.equal(services.saveSettings({ [field]: dir })[field], dir);
    assert.equal(services.saveSettings({ [field]: '' })[field], '');
  }
  assert.equal(services.getSettings().monthlyBudgetCNY, 100);
}));

test('API connection tests use the selected protocol and never claim full agent compatibility', async () => fixture(async dir => {
  const calls = [];
  const module = loadServices({ fetch: async (url, request) => { calls.push({ url, request }); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), { status: 200 }); } });
  const services = new module.WorkbenchServices(dir);
  const saved = services.saveConnection(connectionInput());
  const result = await services.testConnection(saved.id);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'auth-ok');
  assert.match(result.message, /尚未验证/);
  assert.equal(calls[0].url, 'https://fixture.example/v1/messages');
  assert.equal(JSON.parse(calls[0].request.body).model, 'fixture-model');
  assert.equal(JSON.stringify(result).includes(connectionInput().apiKey), false);
}));

test('gateway/model errors are redacted before entering saved connection metadata', async () => fixture(async dir => {
  const key = connectionInput().apiKey;
  const module = loadServices({ fetch: async () => new Response(JSON.stringify({ error: { message: `Rejected ${key}` } }), { status: 401 }) });
  const services = new module.WorkbenchServices(dir);
  const saved = services.saveConnection(connectionInput());
  const result = await services.testConnection(saved.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.message.includes(key), false);
  assert.equal(fs.readFileSync(path.join(dir, 'workbench.json'), 'utf8').includes(key), false);
}));

test('Windows shim quoting leaves shell metacharacters literal and rejects line injection', () => {
  const module = loadServices();
  assert.equal(module.quotePowerShellArgument("model'$(&x)"), "'model''$(&x)'");
  assert.throws(() => module.quotePowerShellArgument('x\ny'), /无效/);
  const plan = module.cliProcessPlan('C:\\fixture folder\\claude.cmd', ['--model', 'model$unsafe']);
  assert.equal(plan.args.includes('-NoProfile'), true);
  assert.match(plan.args.at(-1), /'model\$unsafe'/);
});

test('official provider entries keep ordinary Bailian and monthly Token Plan endpoints separate', () => {
  const module = loadServices();
  const ordinary = module.PROVIDER_PRESETS.find(item => item.id === 'bailian-payg');
  const subscription = module.PROVIDER_PRESETS.find(item => item.id === 'bailian');
  assert.equal(ordinary.baseUrls.anthropic, 'https://dashscope.aliyuncs.com/apps/anthropic');
  assert.equal(ordinary.baseUrls.responses, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(subscription.baseUrls.anthropic.includes('token-plan.'), true);
  assert.equal(ordinary.models.includes('glm-5.3'), true);
  assert.equal(ordinary.models.includes('qwen3.8-max'), true);
  const groq = module.PROVIDER_PRESETS.find(item => item.id === 'groq');
  const openrouter = module.PROVIDER_PRESETS.find(item => item.id === 'openrouter');
  assert.equal(groq.protocols.includes('responses'), true);
  assert.match(groq.compatibility, /Beta/);
  assert.match(groq.note, /previous_response_id/);
  assert.equal(openrouter.baseUrls.responses, 'https://openrouter.ai/api/v1');
});

test('Bailian Claude rejects a Codex endpoint before storing a supplied secret', async () => fixture(async dir => {
  const module = loadServices();
  const services = new module.WorkbenchServices(dir);
  assert.throws(() => services.saveConnection(connectionInput({ presetId: 'bailian-payg', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })), /https:\/\/dashscope.aliyuncs.com\/apps\/anthropic/);
  assert.equal(services.getConnections().length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'api-secrets.local.json')), false);
  assert.throws(() => services.saveConnection(connectionInput({ engine: 'codex' })), /Responses/);
  assert.throws(() => services.saveConnection(connectionInput({ presetId: 'bailian-payg', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic' })), /包月/);
  assert.throws(() => services.saveConnection(connectionInput({ presetId: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' })), /Token Plan/);
}));

test('legacy wrong Bailian Claude URL has a repair message and produces no request or usage record', async () => fixture(async dir => {
  const module = loadServices();
  const services = new module.WorkbenchServices(dir);
  const saved = services.saveConnection(connectionInput({ presetId: 'custom', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' }));
  const statePath = path.join(dir, 'workbench.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.connections[0].baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  fs.writeFileSync(statePath, JSON.stringify(state));
  const captures = [];
  const reloaded = new module.WorkbenchServices(dir, capture => captures.push(capture));
  const result = await reloaded.testConnection(saved.id);
  assert.equal(result.ok, false);
  assert.match(result.message, /Codex\/OpenAI/);
  assert.match(result.message, /apps\/anthropic/);
  assert.equal(captures.length, 0);
}));

test('Bailian Claude uses its Messages endpoint and includes safe connection-test usage metadata', async () => fixture(async dir => {
  const calls = [], captures = [];
  const module = loadServices({ fetch: async (url, request) => {
    calls.push({ url, request });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 10 }, secretField: 'never persist this', model: 'qwen3.8-flash' }), { status: 200 });
  } });
  const services = new module.WorkbenchServices(dir, capture => captures.push(capture));
  const saved = services.saveConnection(connectionInput({ presetId: 'bailian-payg', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen3.8-flash' }));
  assert.equal((await services.testConnection(saved.id)).ok, true);
  assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages');
  assert.equal(JSON.parse(calls[0].request.body).thinking.type, 'disabled');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].kind, 'connection-test');
  assert.equal(captures[0].httpStatus, 200);
  assert.equal(captures[0].tokens.inputTokens, 30);
  assert.equal(captures[0].tokens.cacheReadTokens, 10);
  assert.equal(JSON.stringify(captures).includes('never persist this'), false);
  assert.equal(JSON.stringify(captures).includes(connectionInput().apiKey), false);
}));

test('404 explains a missing route instead of diagnosing balance; network failures record unknown usage', async () => fixture(async dir => {
  const captures = [];
  const module = loadServices({ fetch: async () => new Response('<html>Not found</html>', { status: 404 }) });
  const services = new module.WorkbenchServices(dir, capture => captures.push(capture));
  const saved = services.saveConnection(connectionInput());
  const result = await services.testConnection(saved.id);
  assert.match(result.message, /404/);
  assert.match(result.message, /不能证明/);
  assert.equal(captures[0].tokens, null);
  assert.equal(captures[0].outcome, 'error');
  const failing = loadServices({ fetch: async () => { throw new TypeError('fixture network failure'); } });
  const reloaded = new failing.WorkbenchServices(dir, capture => captures.push(capture));
  await reloaded.testConnection(saved.id);
  assert.equal(captures.at(-1).httpStatus, 0);
  assert.equal(captures.at(-1).tokens, null);
}));

test('manual pricing survives edits and reloads, rejects invalid quotes, and never changes stored credentials', async () => fixture(async dir => {
  const module = loadServices();
  const services = new module.WorkbenchServices(dir);
  const saved = services.saveConnection(connectionInput());
  const price = { currency: 'CNY', inputPerMillion: 1.2, outputPerMillion: 4.5, cacheReadPerMillion: 0.3, source: '用户确认价' };
  const updated = services.savePricing(saved.id, price);
  assert.equal(updated.pricing.outputPerMillion, 4.5);
  price.outputPerMillion = 9;
  assert.equal(services.getConnection(saved.id).pricing.outputPerMillion, 4.5);
  for (const value of [-1, NaN, Infinity, 100001, '2']) assert.throws(() => services.savePricing(saved.id, { currency: 'CNY', inputPerMillion: value, outputPerMillion: 1 }), /有限数字/);
  assert.throws(() => services.savePricing(saved.id, { currency: 'USD', inputPerMillion: 1, outputPerMillion: 1 }), /CNY/);
  assert.equal(services.getSecret(saved.id), connectionInput().apiKey);
  services.saveConnection({ ...connectionInput(), id: saved.id, apiKey: '', name: 'Renamed' });
  const reloaded = new module.WorkbenchServices(dir);
  assert.equal(reloaded.getConnection(saved.id).pricing.outputPerMillion, 4.5);
  reloaded.savePricing(saved.id, null);
  reloaded.saveConnection({ ...connectionInput(), id: saved.id, apiKey: '' });
  assert.equal(reloaded.getConnection(saved.id).pricing, undefined);
}));

test('default Qwen quotes apply only to exact ordinary Beijing models and change with their model scope', async () => fixture(async dir => {
  const module = loadServices();
  const services = new module.WorkbenchServices(dir);
  const base = connectionInput({ presetId: 'bailian-payg', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen3.8-flash' });
  const ordinary = services.saveConnection(base);
  assert.equal(ordinary.pricing.inputPerMillion, 0.8);
  assert.equal(ordinary.pricing.outputPerMillion, 2.7);
  assert.equal(ordinary.pricing.cacheReadPerMillion, 0.1);
  assert.equal(ordinary.pricing.cacheWritePerMillion, 1.25);
  assert.match(ordinary.pricing.verifiedAt, /2026-10-11/);
  const changed = services.saveConnection({ ...base, id: ordinary.id, apiKey: '', model: 'qwen3.8-max' });
  assert.equal(changed.pricing.inputPerMillion,12);assert.equal(changed.pricing.outputPerMillion,36);assert.equal(changed.pricing.cacheReadPerMillion,undefined);assert.equal(changed.pricing.cacheWritePerMillion,15);
  const unsupported=services.saveConnection({...base,id:ordinary.id,apiKey:'',model:'qwen-future'});assert.equal(unsupported.pricing,undefined);
  const overseas = services.saveConnection({ ...base, baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic' });
  assert.equal(overseas.pricing, undefined);
  const plan = services.saveConnection({ ...base, presetId: 'bailian', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic' });
  assert.equal(plan.pricing, undefined);
}));

test('the wrong Alibaba credential type is refused without writing it to a vault', async () => fixture(async dir => {
  const module = loadServices();
  const services = new module.WorkbenchServices(dir);
  const base = connectionInput({ presetId: 'bailian-payg', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' });
  assert.throws(() => services.saveConnection({ ...base, apiKey: 'LTAI' + 'A'.repeat(20) }), /AccessKey ID/);
  assert.throws(() => services.saveConnection({ ...base, apiKey: 'sk-sp-test' }), /Token Plan/);
  assert.equal(fs.existsSync(path.join(dir, 'api-secrets.local.json')), false);
}));

test('shutdown waits for active tests and captures the quote from request start despite edits', async () => fixture(async dir => {
  let release;
  const captures = [];
  const module = loadServices({ fetch: () => new Promise(resolve => { release = resolve; }) });
  const services = new module.WorkbenchServices(dir, capture => captures.push(capture));
  const saved = services.saveConnection(connectionInput({ pricing: { currency: 'CNY', inputPerMillion: 1, outputPerMillion: 2 } }));
  const pending = services.testConnection(saved.id);
  services.savePricing(saved.id, { currency: 'CNY', inputPerMillion: 10, outputPerMillion: 20 });
  let drained = false;
  const drain = services.waitForTests().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release(new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 }));
  assert.equal((await pending).ok, true);
  await drain;
  assert.equal(drained, true);
  assert.equal(captures[0].pricing.outputPerMillion, 2);
  assert.equal(services.getConnection(saved.id).pricing.outputPerMillion, 20);
}));

test('HTTP 200 model failure or incomplete response cannot pass authentication and still captures usage', async () => fixture(async dir => {
  for (const body of [
    { status: 'failed', output: [], error: { message: 'fixture model failure' } },
    { status: 'incomplete', output: [] },
    { content: [], error: { message: 'fixture messages failure' } },
  ]) {
    const captures = [];
    const module = loadServices({ fetch: async () => new Response(JSON.stringify({ ...body, usage: { input_tokens: 11, output_tokens: 32 } }), { status: 200 }) });
    const services = new module.WorkbenchServices(dir, capture => captures.push(capture));
    const protocol = body.output ? 'responses' : 'anthropic';
    const saved = services.saveConnection(connectionInput({ protocol, engine: protocol === 'responses' ? 'codex' : 'claude' }));
    const result = await services.testConnection(saved.id);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(captures[0].tokens.outputTokens, 32);
    assert.equal(captures[0].outcome, 'error');
  }
}));

test('legacy empty Beijing quotes backfill automatically while manual, cleared and untrusted scopes are preserved',async()=>fixture(async dir=>{
  const module=loadServices(),services=new module.WorkbenchServices(dir);
  const base=connectionInput({presetId:'custom',baseUrl:'https://dashscope.aliyuncs.com/apps/anthropic',model:'qwen3.8-flash'});
  const automatic=services.saveConnection(base);
  const discounted=services.saveConnection({...base,name:'discount',pricing:{currency:'CNY',inputPerMillion:.4,outputPerMillion:1.2,source:'用户填写'}});
  const cleared=services.saveConnection({...base,name:'cleared'});services.savePricing(cleared.id,null);
  const overseas=services.saveConnection({...base,name:'overseas',baseUrl:'https://dashscope-intl.aliyuncs.com/apps/anthropic'});
  const proxy=services.saveConnection({...base,name:'proxy',baseUrl:'https://proxy.example/apps/anthropic'});
  const plan=services.saveConnection({...base,name:'plan',presetId:'bailian',baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic'});
  const filename=path.join(dir,'workbench.json'),saved=JSON.parse(fs.readFileSync(filename,'utf8'));
  const legacy=saved.connections.find(item=>item.id===automatic.id);delete legacy.pricing;delete legacy.pricingMode;
  const oldManual=saved.connections.find(item=>item.id===discounted.id);delete oldManual.pricing.origin;delete oldManual.pricing.sourceKind;delete oldManual.pricingMode;
  fs.writeFileSync(filename,JSON.stringify(saved));
  const reloaded=new module.WorkbenchServices(dir);
  assert.equal(reloaded.getConnection(automatic.id).pricing.cacheWritePerMillion,1.25);
  assert.equal(reloaded.getConnection(automatic.id).pricing.origin,'official');assert.equal(reloaded.getConnection(automatic.id).pricing.sourceKind,'builtin');
  assert.equal(reloaded.getConnection(discounted.id).pricing.outputPerMillion,1.2);assert.equal(reloaded.getConnection(discounted.id).pricingMode,'manual');
  assert.equal(reloaded.getConnection(cleared.id).pricing,undefined);assert.equal(reloaded.getConnection(cleared.id).pricingMode,'manual');
  for(const item of [overseas,proxy,plan])assert.equal(reloaded.getConnection(item.id).pricing,undefined);
}));

test('legacy public-price labels require exact four rates and scope; discounts and explicit manual origin remain manual',async()=>fixture(async dir=>{
  const module=loadServices(),services=new module.WorkbenchServices(dir);
  const base=connectionInput({presetId:'custom',baseUrl:'https://dashscope.aliyuncs.com/apps/anthropic',model:'qwen3.8-flash'});
  const price={currency:'CNY',inputPerMillion:.8,outputPerMillion:2.7,cacheReadPerMillion:.1,cacheWritePerMillion:1.25,source:'百炼公开价 · 2026-10-11'};
  const rows=[
    services.saveConnection({...base,name:'published',pricing:price}),
    services.saveConnection({...base,name:'discount',pricing:{...price,inputPerMillion:.4}}),
    services.saveConnection({...base,name:'explicit manual',pricing:price}),
    services.saveConnection({...base,name:'missing fourth rate',pricing:{...price,cacheWritePerMillion:undefined}}),
    services.saveConnection({...base,name:'proxy',baseUrl:'https://proxy.example/apps/anthropic',pricing:price}),
  ];
  const filename=path.join(dir,'workbench.json'),saved=JSON.parse(fs.readFileSync(filename,'utf8'));
  for(const item of saved.connections){delete item.pricingMode;if(item.name!=='explicit manual'){delete item.pricing.origin;delete item.pricing.sourceKind;}}
  fs.writeFileSync(filename,JSON.stringify(saved));const reloaded=new module.WorkbenchServices(dir);
  assert.equal(reloaded.getConnection(rows[0].id).pricingMode,'official');
  for(const item of rows.slice(1))assert.equal(reloaded.getConnection(item.id).pricingMode,'manual',item.name);
}));

test('official price application uses metadata only and skips edits, manual quotes and changed scopes',async()=>fixture(async dir=>{
  const module=loadServices(),services=new module.WorkbenchServices(dir);
  const base=connectionInput({presetId:'custom',baseUrl:'https://dashscope.aliyuncs.com/apps/anthropic',model:'qwen3.8-flash'});
  const automatic=services.saveConnection(base),manual=services.saveConnection({...base,name:'manual',pricing:{currency:'CNY',inputPerMillion:3,outputPerMillion:4}});
  const targets=services.getPricingTargets();
  assert.equal(JSON.stringify(targets).includes(base.apiKey),false);assert.equal(JSON.stringify(targets).includes('hasKey'),false);
  const updatedPrice={currency:'CNY',inputPerMillion:.7,outputPerMillion:2.5,cacheReadPerMillion:.1,cacheWritePerMillion:1.25,origin:'official',sourceKind:'network',sourceUrl:'https://help.aliyun.com/zh/model-studio/qwen3-8-flash',verifiedAt:'2026-10-12T00:00:00Z',source:'官网报价'};
  const results=targets.map(target=>({connectionId:target.connectionId,status:'updated',message:'updated',pricing:updatedPrice}));
  const savedVault=fs.readFileSync(path.join(dir,'api-secrets.local.json'),'utf8');
  const originalGetSecret=services.getSecret;services.getSecret=()=>{throw new Error('pricing must not access credentials');};
  assert.equal(services.getPricingTargets().length,2);
  const report=services.applyOfficialPricing(results,targets);assert.equal(report.updatedCount,1);assert.equal(report.manualSkippedCount,1);
  services.getSecret=originalGetSecret;
  assert.equal(services.getConnection(automatic.id).pricing.outputPerMillion,2.5);assert.equal(services.getConnection(manual.id).pricing.outputPerMillion,4);
  assert.equal(fs.readFileSync(path.join(dir,'api-secrets.local.json'),'utf8'),savedVault);
  const waiting=services.getPricingTargets([automatic.id]);services.savePricing(automatic.id,{currency:'CNY',inputPerMillion:9,outputPerMillion:10});
  const conflict=services.applyOfficialPricing([results[0]],waiting,true);assert.equal(conflict.results[0].status,'changed-skipped');assert.equal(services.getConnection(automatic.id).pricing.outputPerMillion,10);
  const newScope=services.getPricingTargets([automatic.id]);services.saveConnection({...base,id:automatic.id,apiKey:'',model:'qwen3.8-max'});
  assert.equal(services.applyOfficialPricing([results[0]],newScope,true).results[0].status,'changed-skipped');
  const follow=services.getPricingTargets([manual.id]);services.applyOfficialPricing([results[1]],follow,true);
  assert.equal(services.getConnection(manual.id).pricingMode,'official');assert.equal(services.getConnection(manual.id).pricing.origin,'official');
}));

test('network lookup failures keep the last quote and explicit cleared manual state persists',async()=>fixture(async dir=>{
  const module=loadServices(),services=new module.WorkbenchServices(dir);
  const saved=services.saveConnection(connectionInput({presetId:'custom',baseUrl:'https://dashscope.aliyuncs.com/apps/anthropic',model:'qwen3.8-flash'}));
  const targets=services.getPricingTargets([saved.id]),before=services.getConnection(saved.id).pricing;
  const report=services.applyOfficialPricing([{connectionId:saved.id,status:'failed',message:'fixture timeout'}],targets);
  assert.equal(report.failedCount,1);assert.deepEqual(services.getConnection(saved.id).pricing,before);
  services.savePricing(saved.id,null);const reload=new module.WorkbenchServices(dir);assert.equal(reload.getConnection(saved.id).pricing,undefined);assert.equal(reload.getConnection(saved.id).pricingMode,'manual');
}));
