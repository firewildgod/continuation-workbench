const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadPricing() {
  const unit = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'pricing.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, {
    module: unit, exports: unit.exports, URL, TextDecoder, AbortController, setTimeout, clearTimeout,
    fetch: () => { throw new Error('Fixture test must never send a real network request'); },
  }, { filename: 'pricing.ts' });
  return unit.exports;
}
const pricing = loadPricing();
const DATE = '2026-10-11T12:00:00.000Z';
const SOURCE_FLASH = 'https://help.aliyun.com/zh/model-studio/qwen3-8-flash';
const SOURCE_MAX = 'https://help.aliyun.com/zh/model-studio/qwen3-8-max';
const FLASH_ROWS = [['输入', '0.8'], ['输出', '2.7'], ['输入（缓存命中）', '0.1'], ['显式缓存创建', '1.25'], ['显式缓存命中', '0.1']];
const MAX_ROWS = [['输入', '12'], ['输出', '36'], ['输入（缓存命中）', '1.5'], ['输入（Batch File）', '6'], ['输出（Batch File）', '18'], ['显式缓存创建', '15'], ['显式缓存命中', '1'], ['输入（Batch Chat）', '12'], ['输出（Batch Chat）', '36']];
function target(overrides = {}) {
  return { connectionId: 'fixture', name: 'No key metadata', model: 'qwen3.8-flash', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', presetId: 'custom', engine: 'codex', protocol: 'responses', ...overrides };
}
function table(rows = FLASH_ROWS, options = {}) {
  return `<table><thead><tr><th>计费项</th><th${options.headerSpan ? ' colspan="2"' : ''}>价格（元）</th><th>单位</th></tr></thead><tbody>${rows.map(([label, value, unit]) => `<tr><td><p>${label}</p></td><td${options.cellSpan ? ' rowspan="2"' : ''}><p>${value}</p></td><td><p>${unit || '每百万<span class="help-letter-space"></span>tokens'}</p></td></tr>`).join('')}</tbody></table>`;
}
function article(rows = FLASH_ROWS, options = {}) {
  const beijing = `<section id="华北2-北京-2"><h4>华北<span class="help-letter-space"></span>2（北京）</h4>${options.contextNote || ''}${table(rows, options)}</section>`;
  const singapore = `<section><h4>新加坡</h4>${table([['输入', '999'], ['输出', '888']])}</section>`;
  return `<div><p>模型调用 ID：<code>${options.model || 'qwen3.8-flash'}</code></p><h2>模型能力</h2><section><h4>华北2（北京）</h4>${table([['输入', '123'], ['输出', '456']])}</section><h2 id="模型价格">模型价格 <span></span></h2><p>模型原价；活动以官方控制台为准。</p><section data-tag="tabbed-content-box">${singapore}${beijing}${options.duplicateRegion ? beijing : ''}</section><h2>请求限流</h2>${table([['输入', '777'], ['输出', '666']])}</div>`;
}
function page(rows = FLASH_ROWS, options = {}) {
  const props = { docDetailData: { storeData: { data: { docTitle: options.model || 'qwen3.8-flash', content: article(rows, options) } } } };
  return `<!DOCTYPE html><title>Official fixture</title><script>window.pageStartTime=Date.now();</script><script>window.__ICE_SSR_ENABLED__=true; window.__ICE_PAGE_PROPS__ = ${JSON.stringify(props)};</script>`;
}
function response(html = page(), options = {}) {
  return new Response(html, { status: options.status || 200, headers: { 'content-type': 'text/html; charset=utf-8', ...options.headers } });
}

test('dated snapshots resolve exact Beijing ordinary models, including a legacy Claude URL', () => {
  const flash = pricing.getBuiltInPricing(target());
  assert.equal(flash.inputPerMillion, 0.8);
  assert.equal(flash.outputPerMillion, 2.7);
  assert.equal(flash.cacheReadPerMillion, 0.1);
  assert.equal(flash.cacheWritePerMillion, 1.25);
  assert.equal(flash.origin, 'official');
  assert.equal(flash.sourceKind, 'builtin');
  assert.equal(flash.sourceUrl, SOURCE_FLASH);
  assert.equal(flash.verifiedAt, '2026-10-11T00:00:00+08:00');
  const legacy = target({ engine: 'claude', protocol: 'anthropic' });
  const originalUrl = legacy.baseUrl;
  assert.equal(pricing.getBuiltInPricing(legacy).inputPerMillion, 0.8);
  assert.equal(legacy.baseUrl, originalUrl);
  const max = pricing.getBuiltInPricing(target({ model: 'qwen3.8-max' }));
  assert.equal(max.inputPerMillion, 12);
  assert.equal(max.outputPerMillion, 36);
  assert.equal(max.cacheWritePerMillion, 15);
  assert.equal(max.cacheReadPerMillion, undefined);
  assert.match(max.note, /隐式.*1\.5.*显式.*1.*暂不计价/);
});

test('only documented Beijing workspace hosts and known roots resolve a snapshot', () => {
  assert.ok(pricing.getBuiltInPricing(target({ presetId: 'bailian-payg', baseUrl: 'https://workspace-123.cn-beijing.maas.aliyuncs.com/apps/anthropic/' })));
  assert.ok(pricing.getBuiltInPricing(target({ baseUrl: 'https://dashscope.aliyuncs.com:443/apps/anthropic/v1' })));
  const unsupported = [
    { model: 'qwen3.8-flash[1m]' }, { model: 'qwen3.8-flash-snapshot' }, { model: 'qwen3.8-FlAsh' }, { model: 'unknown' },
    { presetId: 'bailian' }, { presetId: 'openrouter' },
    { baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic' },
    { baseUrl: 'https://coding-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
    { baseUrl: 'https://workspace.cn-singapore.maas.aliyuncs.com/apps/anthropic' },
    { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    { baseUrl: 'https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1' },
    { baseUrl: 'https://proxy.example/dashscope.aliyuncs.com/compatible-mode/v1' },
    { baseUrl: 'https://dashscope.aliyuncs.com:8443/compatible-mode/v1' },
    { baseUrl: 'http://dashscope.aliyuncs.com/compatible-mode/v1' },
    { baseUrl: 'https://username:password@dashscope.aliyuncs.com/compatible-mode/v1' },
    { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1?key=value' },
    { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1#fragment' },
    { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/responses' }, { baseUrl: 'invalid' },
  ];
  for (const overrides of unsupported) assert.equal(pricing.getBuiltInPricing(target(overrides)), undefined, JSON.stringify(overrides));
});

test('parser chooses model price, Beijing and exact billing labels rather than the first numbers', () => {
  const value = pricing.parseBailianPricingPage('qwen3.8-flash', page(), DATE);
  assert.equal(value.inputPerMillion, 0.8);
  assert.equal(value.outputPerMillion, 2.7);
  assert.equal(value.cacheReadPerMillion, 0.1);
  assert.equal(value.cacheWritePerMillion, 1.25);
  assert.equal(value.sourceKind, 'network');
  assert.equal(value.verifiedAt, DATE);
  assert.equal(value.contextMaxTokens, undefined);
});

test('Max excludes Batch rows and leaves ambiguous cache reads unpriced for both protocols', () => {
  const value = pricing.parseBailianPricingPage('qwen3.8-max', page(MAX_ROWS, { model: 'qwen3.8-max' }), DATE);
  assert.equal(value.inputPerMillion, 12);
  assert.equal(value.outputPerMillion, 36);
  assert.equal(value.cacheWritePerMillion, 15);
  assert.equal(value.cacheReadPerMillion, undefined);
  assert.match(value.note, /隐式缓存命中 1\.5.*显式缓存命中 1.*暂不计价/);
});

test('zero is a real price and inline whitespace/entities do not erase it', () => {
  const rows = FLASH_ROWS.map(([label]) => [label, ' <strong>&#48;</strong> ', '每百万&nbsp;tokens']);
  const value = pricing.parseBailianPricingPage('qwen3.8-flash', page(rows), DATE);
  assert.equal(value.inputPerMillion, 0);
  assert.equal(value.outputPerMillion, 0);
  assert.equal(value.cacheReadPerMillion, 0);
  assert.equal(value.cacheWritePerMillion, 0);
});

test('missing cache fees are unknown and are never filled from an old or other-region rate', () => {
  const value = pricing.parseBailianPricingPage('qwen3.8-flash', page([['输出', '3'], ['输入', '1']]), DATE);
  assert.equal(value.inputPerMillion, 1);
  assert.equal(value.outputPerMillion, 3);
  assert.equal(value.cacheReadPerMillion, undefined);
  assert.equal(value.cacheWritePerMillion, undefined);
  assert.match(value.note, /缓存读取暂不计价.*缺少显式缓存创建/);
  const oneRead = pricing.parseBailianPricingPage('qwen3.8-flash', page([['输入', '1'], ['输出', '3'], ['显式缓存命中', '0.1']]), DATE);
  assert.equal(oneRead.cacheReadPerMillion, undefined);
});

test('reordered rows and assignment whitespace are accepted without executing any scripts', () => {
  const html = page([...FLASH_ROWS].reverse()).replace('window.__ICE_PAGE_PROPS__ = ', 'window.__ICE_PAGE_PROPS__\n =\n ').replace('window.pageStartTime=Date.now();', 'throw new Error("must not execute");');
  assert.equal(pricing.parseBailianPricingPage('qwen3.8-flash', html, DATE).outputPerMillion, 2.7);
});

test('model mismatch, duplicate regions and malformed embedding cannot produce a quote', () => {
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page(MAX_ROWS, { model: 'qwen3.8-max' }), DATE), /模型标识/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page(FLASH_ROWS, { duplicateRegion: true }), DATE), /唯一定位/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', '<script>window.__ICE_PAGE_PROPS__ = notJson();</script>', DATE), /数据格式/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page() + page(), DATE), /数据格式/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page().replace('docDetailData', 'futureData'), DATE), /模型标识/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page(), 'invalid date'), /日期无效/);
});

test('unexpected price, currency, unit and duplicated standard rows fail closed', () => {
  const invalidValues = ['免费至月底', '约 0.8', '0.8 / 1.6', '0.8元', '-1', 'NaN', 'Infinity', '1e2', '100001', '1,000'];
  for (const value of invalidValues) assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page([['输入', value], ['输出', '2.7']]), DATE), /价格.*数值/, value);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page([['输入', '0.8', '每千tokens'], ['输出', '2.7']]), DATE), /计费单位/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page([...FLASH_ROWS, ['输入', '1']]), DATE), /计费项重复/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page([['输入', '0.8']]), DATE), /缺少标准/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page().replaceAll('价格（元）', '价格（美元）'), DATE), /价格列/);
});

test('verification timestamps preserve a Beijing midnight boundary without a misleading UTC date in source text', () => {
  for (const date of ['2026-10-11T15:59:59.999Z', '2026-10-11T16:00:00.000Z']) {
    const value = pricing.parseBailianPricingPage('qwen3.8-flash', page(), date);
    assert.equal(value.verifiedAt, date);
    assert.equal(value.updatedAt, date);
    assert.equal(value.source, '百炼官网 · 北京按量');
  }
});

test('context tiers, merged cells and new unknown billing items require a parser update', () => {
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page([['输入（≤32K）', '0.8'], ['输入（>32K）', '1.6'], ['输出', '2.7']]), DATE), /计费项或上下文阶梯/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page(FLASH_ROWS, { contextNote: '<p>输入长度 ≤ 32K，上下文使用分档价格。</p>' }), DATE), /上下文档位/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page(FLASH_ROWS, { cellSpan: true }), DATE), /阶梯或合并列/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page(FLASH_ROWS, { headerSpan: true }), DATE), /价格列或上下文档位/);
  assert.throws(() => pricing.parseBailianPricingPage('qwen3.8-flash', page([...FLASH_ROWS, ['音频输入', '2']]), DATE), /计费项或上下文阶梯/);
});

test('refresh fetches fixed documentation once per model, omits credentials, and never mutates targets', async () => {
  const calls = [];
  const existing = { currency: 'CNY', inputPerMillion: 99, outputPerMillion: 199, origin: 'manual' };
  const targets = [target({ pricing: existing, pricingMode: 'manual' }), target({ connectionId: 'claude', engine: 'claude', protocol: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' }), target({ connectionId: 'max', model: 'qwen3.8-max' })];
  const before = JSON.stringify(targets);
  const result = await pricing.fetchOfficialPricing(targets, { fetch: async (url, init) => {
    calls.push({ url, init });
    return response(url === SOURCE_MAX ? page(MAX_ROWS, { model: 'qwen3.8-max' }) : page());
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(item => item.url).sort(), [SOURCE_FLASH, SOURCE_MAX].sort());
  for (const { init } of calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    assert.deepEqual(Object.keys(init.headers), ['Accept']); assert.equal(init.body, undefined);
  }
  assert.equal(result.every(item => item.status === 'updated'), true);
  assert.equal(result[0].pricing.inputPerMillion, 0.8);
  assert.notEqual(result[0].pricing, result[1].pricing);
  assert.equal(JSON.stringify(targets), before);
});

test('unsupported scopes send zero requests and explain why no ordinary price is applied', async () => {
  let called = false;
  const results = await pricing.fetchOfficialPricing([target({ presetId: 'bailian' }), target({ baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }), target({ model: 'different-model' })], { fetch: async () => { called = true; throw new Error('must never run'); } });
  assert.equal(called, false);
  assert.equal(results.every(item => item.status === 'unsupported' && !item.pricing), true);
});

test('only a bounded same-page HTTPS redirect is followed', async () => {
  const calls = [];
  const success = await pricing.fetchOfficialPricing([target()], { fetch: async url => {
    calls.push(url);
    return calls.length === 1 ? response('', { status: 301, headers: { location: `${SOURCE_FLASH}/` } }) : response();
  } });
  assert.equal(success[0].status, 'updated'); assert.equal(calls.length, 2);
  const badLocations = ['https://evil.example/price', 'http://help.aliyun.com/zh/model-studio/qwen3-8-flash', SOURCE_MAX, `${SOURCE_FLASH}?credential=value`, 'https://user:secret@help.aliyun.com/zh/model-studio/qwen3-8-flash'];
  for (const location of badLocations) {
    let count = 0;
    const result = await pricing.fetchOfficialPricing([target()], { fetch: async () => { count++; return response('', { status: 302, headers: { location } }); } });
    assert.equal(result[0].status, 'failed'); assert.equal(result[0].pricing, undefined); assert.equal(count, 1);
    assert.equal(result[0].message.includes('secret'), false);
  }
  let count = 0;
  const loop = await pricing.fetchOfficialPricing([target()], { fetch: async () => { count++; return response('', { status: 307, headers: { location: SOURCE_FLASH } }); } });
  assert.equal(loop[0].status, 'failed'); assert.equal(count, 3);
});

test('HTTP failure and HTML format drift retain old pricing rather than replacing it with a snapshot', async () => {
  const oldPricing = { currency: 'CNY', inputPerMillion: 5, outputPerMillion: 10 };
  const chosen = target({ pricing: oldPricing });
  for (const fixture of [response('', { status: 404 }), response('changed format'), response(page(), { headers: { 'content-type': 'application/json' } })]) {
    const result = await pricing.fetchOfficialPricing([chosen], { fetch: async () => fixture });
    assert.equal(result[0].status, 'failed'); assert.equal(result[0].pricing, undefined);
    assert.equal(chosen.pricing, oldPricing);
  }
});

test('content length and streamed response limits apply even without a trustworthy length header', async () => {
  const length = await pricing.fetchOfficialPricing([target()], { fetch: async () => response('small', { headers: { 'content-length': String(1024 * 1024 + 1) } }) });
  assert.equal(length[0].status, 'failed'); assert.match(length[0].message, /大小限制/);
  const stream = await pricing.fetchOfficialPricing([target()], { fetch: async () => response('x'.repeat(1024 * 1024 + 1)) });
  assert.equal(stream[0].status, 'failed'); assert.match(stream[0].message, /大小限制/);
});

test('an aborted or unavailable public source fails with a safe diagnostic and bounded wait', async () => {
  const timeout = await pricing.fetchOfficialPricing([target()], { timeoutMs: 10, fetch: async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('private failure')), { once: true })) });
  assert.equal(timeout[0].status, 'failed'); assert.match(timeout[0].message, /超时/);
  const failure = await pricing.fetchOfficialPricing([target()], { fetch: async () => { throw new Error('secret / raw body should never be displayed'); } });
  assert.equal(failure[0].status, 'failed'); assert.equal(failure[0].message.includes('secret'), false);
});
