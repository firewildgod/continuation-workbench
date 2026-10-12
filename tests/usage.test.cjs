const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {UsageObserver,UsageLedger,normalizeUsage,estimateUsageCost,validateUsagePricing,shanghaiDate}=require('../dist/main/usage.js');
const price={currency:'CNY',inputPerMillion:1,outputPerMillion:4,cacheReadPerMillion:0.1,cacheWritePerMillion:1.25};
function capture(extra={}) { return {connectionId:'conn-a',connectionName:'百炼',engine:'codex',model:'model-a',startedAt:'2026-10-10T16:00:00.000Z',finishedAt:'2026-10-10T16:00:01.000Z',httpStatus:200,outcome:'success',kind:'request',tokens:{inputTokens:1000,outputTokens:100,cacheReadTokens:800,cacheWriteTokens:0},...extra}; }

test('Responses cache and reasoning are subsets; Anthropic cache reads/writes join total input exactly once',()=>{
  const response=normalizeUsage({input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:800},output_tokens_details:{reasoning_tokens:60}},'responses');
  assert.deepEqual(response,{inputTokens:1000,outputTokens:100,cacheReadTokens:800,cacheWriteTokens:0,reasoningTokens:60});
  assert.equal(estimateUsageCost(response,price),0.00068);
  const anthropic=normalizeUsage({input_tokens:200,output_tokens:100,cache_read_input_tokens:800,cache_creation_input_tokens:50},'anthropic');
  assert.equal(anthropic.inputTokens,1050);assert.equal(estimateUsageCost(anthropic,price),0.0007425);
  assert.equal(normalizeUsage({input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:20}},'responses'),undefined);
  assert.equal(normalizeUsage({input_tokens:10},'responses'),undefined);
  const bailian=normalizeUsage({input_tokens:1050,output_tokens:100,input_tokens_details:{cached_tokens:800,cache_creation_input_tokens:50}},'responses');
  assert.equal(bailian.cacheWriteTokens,50);assert.equal(estimateUsageCost(bailian,price),0.0007425);
});
test('missing usage or cache pricing stays unknown; explicitly free pricing remains zero',()=>{
  const tokens=capture().tokens;
  assert.equal(estimateUsageCost(tokens,undefined),null);
  assert.equal(estimateUsageCost(undefined,price),null);
  assert.equal(estimateUsageCost(tokens,{currency:'CNY',inputPerMillion:1,outputPerMillion:4}),null);
  assert.equal(estimateUsageCost(tokens,{currency:'CNY',inputPerMillion:0,outputPerMillion:0,cacheReadPerMillion:0}),0);
  assert.equal(validateUsagePricing({...price,inputPerMillion:NaN}),undefined);
  assert.equal(validateUsagePricing({...price,cacheWritePerMillion:-1}),undefined);
});
test('Responses SSE tolerates split UTF-8/CRLF chunks and takes only terminal usage, never content',()=>{
  const observer=new UsageObserver('responses','text/event-stream; charset=utf-8');
  const event='event: response.output_text.delta\r\ndata: {"delta":"私密内容"}\r\n\r\nevent: response.completed\r\ndata: {"type":"response.completed","response":{"model":"actual-model","output":[{"text":"PRIVATE PROMPT"}],"usage":{"input_tokens":1000,"output_tokens":100,"input_tokens_details":{"cached_tokens":800}}}}\r\n\r\n';
  const bytes=Buffer.from(event);for(let i=0;i<bytes.length;i+=7)observer.write(bytes.subarray(i,i+7));
  const result=observer.finish();assert.equal(result.complete,true);assert.equal(result.model,'actual-model');assert.equal(result.tokens.cacheReadTokens,800);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|私密/);
});
test('Anthropic SSE delta output is cumulative; interrupted messages have no complete usage',()=>{
  const observer=new UsageObserver('anthropic','text/event-stream');
  observer.write('event: message_start\ndata: {"type":"message_start","message":{"model":"glm","usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}}\n\n');
  observer.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  const result=observer.finish();assert.equal(result.complete,true);assert.equal(result.tokens.inputTokens,130);assert.equal(result.tokens.outputTokens,7);
  const interrupted=new UsageObserver('anthropic','text/event-stream');
  interrupted.write('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n');
  assert.equal(interrupted.finish(false).complete,false);
});
test('JSON metadata and bounded malformed streams are safe; missing provider counters are not zero',()=>{
  const observer=new UsageObserver('responses','application/json');observer.write('{"model":"foo","usage":{"input_tokens":2,"output_tokens":3}}');assert.equal(observer.finish().tokens.outputTokens,3);
  const malformed=new UsageObserver('responses','text/event-stream');malformed.write('event: response.completed\ndata: {not json}\n\n');assert.equal(malformed.finish().tokens,undefined);
  const huge=new UsageObserver('responses','application/json');huge.write('x'.repeat(2*1024*1024+1));assert.equal(huge.finish().tokens,undefined);
  const partial=new UsageObserver('responses','application/json');partial.write('{"usage":{"input_tokens":5,"output_tokens":5}}');assert.equal(partial.finish(false).tokens,undefined);
});
test('Shanghai today/month boundaries, partial pricing, persistence and whitelisted metadata',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-ledger-'));
  try {
    const ledger=new UsageLedger(dir);
    ledger.record(capture({startedAt:'2026-10-10T15:59:00.000Z',finishedAt:'2026-10-10T15:59:59.999Z'}),price);
    const known=ledger.record(capture({prompt:'DO NOT STORE',apiKey:'DO NOT STORE',response:{text:'DO NOT STORE'}}),price);
    ledger.record(capture({connectionId:'conn-b',connectionName:'未知模型',model:'unknown',tokens:null,outcome:'error',httpStatus:429}));
    await ledger.flush();
    const summary=ledger.summary(new Date('2026-10-11T00:00:00Z'));
    assert.equal(summary.today.requestCount,2);assert.equal(summary.month.requestCount,3);assert.equal(summary.today.costCNY,null);
    assert.equal(summary.today.knownCostCNY,known.costCNY);assert.equal(summary.today.unknownUsageRequests,1);assert.equal(summary.today.unpricedRequests,1);
    assert.equal(summary.daily.length,30);assert.equal(summary.daily.at(-1).requestCount,2);assert.equal(summary.byConnection.length,2);assert.equal(summary.byModel.length,2);
    assert.equal(ledger.records({range:'today'},new Date('2026-10-11T00:00:00Z')).length,2);
    const disk=fs.readFileSync(ledger.filename,'utf8');assert.doesNotMatch(disk,/DO NOT STORE|prompt|apiKey|response/);
    const restored=new UsageLedger(dir);assert.deepEqual(restored.summary(new Date('2026-10-11T00:00:00Z')),summary);
    assert.equal(shanghaiDate(new Date('2026-10-31T16:00:00Z')),'2026-11-01');
    assert.equal(restored.summary(new Date('2026-11-01T00:00:00Z')).month.costCNY,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('prices are per-call snapshots, errors retain reported charge, unknown JSONL rows do not poison totals',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-ledger-'));
  try {
    const ledger=new UsageLedger(dir);const row=ledger.record(capture({outcome:'error',httpStatus:500}),price);
    price.inputPerMillion=2;assert.equal(row.pricing.inputPerMillion,1);price.inputPerMillion=1;
    await ledger.flush();fs.appendFileSync(ledger.filename,'malformed line\n');
    const restored=new UsageLedger(dir);assert.equal(restored.records().length,1);assert.match(restored.getError(),/部分费用记录/);
    assert.equal(restored.summary(new Date('2026-10-11T00:00:00Z')).today.failedCount,1);
    assert.equal(restored.summary(new Date('2026-10-11T00:00:00Z')).today.costCNY,row.costCNY);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
