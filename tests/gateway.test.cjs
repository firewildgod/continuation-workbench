const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {LocalGateway}=require('../dist/main/gateway.js');
const token='local-token-for-fixtures-0000000000000000000000';
async function fixture(handler, options={}) {
  const upstream=http.createServer(handler);
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const port=upstream.address().port;
  const connections={
    a:{id:'a',name:'a',engine:'codex',protocol:'responses',baseUrl:`http://127.0.0.1:${port}/v1`,model:'model-a'},
    b:{id:'b',name:'b',engine:'codex',protocol:'responses',baseUrl:`http://127.0.0.1:${port}/v1`,model:'model-b'},
    c:{id:'c',name:'c',engine:'claude',protocol:'anthropic',baseUrl:`http://127.0.0.1:${port}/anthropic`,model:'model-c'},
    d:{id:'d',name:'desktop',engine:'claude',protocol:'anthropic',baseUrl:`http://127.0.0.1:${port}/anthropic-desktop`,model:'model-d'},
    e:{id:'e',name:'alternate',engine:'claude',protocol:'anthropic',baseUrl:`http://127.0.0.1:${port}/anthropic-next`,model:'model-e'},
  };
  const gateway=new LocalGateway({token,port:0,getConnection:id=>connections[id],getSecret:id=>connections[id]?'vendor-fixture-key':undefined,...options});
  await gateway.start();gateway.setRoute('codex','a');gateway.setRoute('claude','c');
  return {gateway,connections,upstream,base:gateway.status().baseUrl,close:async()=>{await gateway.stop();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}};
}
function request(base,path='/codex/v1/responses',extra={}) {
  return fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...extra},body:JSON.stringify({model:'client-alias',input:'fixture',stream:true})});
}
test('rejects missing auth, browser origin, arbitrary paths and invalid engine protocol',async()=>{
  let calls=0;const f=await fixture((_q,r)=>{calls++;r.end('{}');});
  try {
    assert.equal((await fetch(f.base+'/codex/v1/responses')).status,401);
    assert.equal((await request(f.base,undefined,{origin:'https://example.com'})).status,401);
    assert.equal((await request(f.base,'/codex/v1/arbitrary')).status,404);
    assert.equal((await request(f.base,'/claude/v1/messages?arbitrary=1')).status,400);
    assert.throws(()=>f.gateway.setRoute('codex','c'),/不匹配/);
    assert.equal(calls,0);
  } finally {await f.close();}
});
test('preserves Responses SSE and forwards vendor key, model and tools without retry',async()=>{
  let got;const f=await fixture(async(q,r)=>{
    const chunks=[];for await(const chunk of q)chunks.push(chunk);
    got={path:q.url,auth:q.headers.authorization,body:JSON.parse(Buffer.concat(chunks).toString())};
    r.writeHead(200,{'content-type':'text/event-stream'});
    r.write('event: response.output_text.delta\ndata: {"delta":"one"}\n\n');
    setTimeout(()=>r.end('data: [DONE]\n\n'),25);
  });
  try {
    const response=await request(f.base),text=await response.text();
    assert.equal(response.headers.get('content-type'),'text/event-stream');
    assert.match(text,/one/);assert.match(text,/\[DONE\]/);
    assert.equal(got.path,'/v1/responses');assert.equal(got.auth,'Bearer vendor-fixture-key');assert.equal(got.body.model,'model-a');
    assert.equal(f.gateway.status().requestCounts.codex,1);assert.equal(f.gateway.status().activeRequests,0);
  } finally {await f.close();}
});
test('Claude beta query and provider prefix survive; upstream 429 is returned once',async()=>{
  let got;let count=0;const f=await fixture(async(q,r)=>{
    count++;const chunks=[];for await(const chunk of q)chunks.push(chunk);
    got={path:q.url,key:q.headers['x-api-key'],beta:q.headers['anthropic-beta'],body:JSON.parse(Buffer.concat(chunks).toString())};
    r.writeHead(429,{'content-type':'application/json','retry-after':'30'});r.end('{"error":{"type":"rate_limit_error"}}');
  });
  try {
    const response=await request(f.base,'/claude/v1/messages?beta=true',{'anthropic-beta':'tools-fixture'});
    assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'30');await response.text();
    assert.equal(got.path,'/anthropic/v1/messages?beta=true');assert.equal(got.key,'vendor-fixture-key');assert.equal(got.beta,'tools-fixture');assert.equal(got.body.model,'model-c');assert.equal(count,1);
  } finally {await f.close();}
});
test('refuses switching during a request and pauses ingress during config mutation',async()=>{
  let finish,arrived;const ready=new Promise(resolve=>arrived=resolve);
  const f=await fixture((_q,r)=>{finish=()=>r.end('{}');arrived();});
  try {
    const task=request(f.base);await ready;
    assert.throws(()=>f.gateway.setRoute('codex','b'),/执行中/);assert.throws(()=>f.gateway.pause('codex'),/执行中/);
    finish();await (await task).text();
    f.gateway.pause('codex');assert.equal((await request(f.base)).status,503);f.gateway.setRoute('codex','b');f.gateway.resume('codex');
    assert.equal(f.gateway.status().routes.codex,'b');assert.equal(f.gateway.status().requestCounts.codex,1);
  } finally {await f.close();}
});
test('usage observer preserves first chunk timing and emits one completed request without prompts',async()=>{
  const records=[];let finish;
  const f=await fixture((_q,r)=>{
    r.writeHead(200,{'content-type':'text/event-stream'});
    r.write('event: response.output_text.delta\ndata: {"delta":"hello"}\n\n');
    finish=()=>r.end('event: response.completed\ndata: {"type":"response.completed","response":{"model":"resolved-model","usage":{"input_tokens":100,"output_tokens":9,"input_tokens_details":{"cached_tokens":80}}}}\n\n');
  },{onUsage:record=>records.push(record)});
  try {
    const response=await request(f.base),reader=response.body.getReader();
    assert.match(Buffer.from((await reader.read()).value).toString(),/hello/);assert.equal(records.length,0);
    finish();let result='';for(;;){const next=await reader.read();if(next.done)break;result+=Buffer.from(next.value).toString();}
    assert.match(result,/resolved-model/);assert.equal(records.length,1);assert.equal(records[0].outcome,'success');
    assert.equal(records[0].tokens.inputTokens,100);assert.equal(records[0].tokens.cacheReadTokens,80);assert.equal(records[0].model,'resolved-model');
    assert.doesNotMatch(JSON.stringify(records),/fixture|vendor-fixture-key|hello|client-alias/);
    assert.equal(f.gateway.status().activeRequests,0);
  } finally {await f.close();}
});
test('Claude JSON uses normalized cache totals; HTTP failures stay unknown; count_tokens is excluded',async()=>{
  const records=[];let mode='json';
  const f=await fixture((_q,r)=>{
    r.writeHead(mode==='error'?429:200,{'content-type':'application/json'});
    r.end(mode==='error'?'{"error":{"message":"quota"}}':'{"model":"actual-claude","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":50,"cache_creation_input_tokens":5}}');
  },{onUsage:record=>records.push(record)});
  try {
    await (await request(f.base,'/claude/v1/messages')).text();assert.equal(records.length,1);assert.equal(records[0].tokens.inputTokens,65);
    mode='error';await (await request(f.base,'/claude/v1/messages')).text();assert.equal(records.length,2);assert.equal(records[1].tokens,null);assert.equal(records[1].outcome,'error');assert.equal(records[1].httpStatus,429);
    mode='json';await (await request(f.base,'/claude/v1/messages/count_tokens')).text();assert.equal(records.length,2);
    await (await fetch(f.base+'/codex/v1/models',{headers:{authorization:`Bearer ${token}`}})).text();assert.equal(records.length,2);
  } finally {await f.close();}
});
test('client cancellation emits unknown usage once and accounting callback exceptions cannot break forwarding',async()=>{
  const records=[];let released;const releasedPromise=new Promise(resolve=>released=resolve);
  const f=await fixture((_q,r)=>{
    r.writeHead(200,{'content-type':'text/event-stream'});
    r.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n');
  },{onUsage:record=>{records.push(record);released();throw new Error('ledger failure fixture');}});
  try {
    const controller=new AbortController();
    const response=await fetch(f.base+'/claude/v1/messages',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{"model":"ignored","stream":true}',signal:controller.signal});
    const reader=response.body.getReader();await reader.read();controller.abort();await assert.rejects(reader.read());
    await releasedPromise;assert.equal(records.length,1);assert.equal(records[0].outcome,'cancelled');assert.equal(records[0].tokens,null);
    assert.equal(f.gateway.status().activeRequests,0);
  } finally {await f.close();}
});
test('SSE model errors are errors even when HTTP is 200; valid reported usage is retained',async()=>{
  const records=[];
  const f=await fixture((_q,r)=>{
    r.writeHead(200,{'content-type':'text/event-stream'});
    r.end('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","usage":{"input_tokens":50,"output_tokens":3}}}\n\n');
  },{onUsage:record=>{records.push(record);throw new Error('optional accounting callback');}});
  try {
    const response=await request(f.base);assert.equal(response.status,200);assert.match(await response.text(),/response.failed/);
    assert.equal(records.length,1);assert.equal(records[0].outcome,'error');assert.equal(records[0].tokens.inputTokens,50);
    assert.equal(f.gateway.status().activeRequests,0);
  } finally {await f.close();}
});
test('request pricing is snapshotted before inference, even when the connection price changes midstream',async()=>{
  const records=[];let finish;
  const f=await fixture((_q,r)=>{
    r.writeHead(200,{'content-type':'text/event-stream'});
    r.write('event: response.output_text.delta\ndata: {"delta":"streaming"}\n\n');
    finish=()=>r.end('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":9}}}\n\n');
  },{onUsage:record=>records.push(record)});
  f.connections.a.pricing={currency:'CNY',inputPerMillion:1,outputPerMillion:4,source:'original quote'};
  try {
    const response=await request(f.base),reader=response.body.getReader();await reader.read();
    f.connections.a.pricing.outputPerMillion=9;f.connections.a.pricing.source='new quote';
    finish();for(;;){if((await reader.read()).done)break;}
    assert.equal(records.length,1);assert.equal(records[0].pricing.outputPerMillion,4);assert.equal(records[0].pricing.source,'original quote');
    assert.notEqual(records[0].pricing,f.connections.a.pricing);
  } finally {await f.close();}
});
test('stopping the gateway waits for cancelled request accounting before the ledger can flush',async()=>{
  const records=[];
  const f=await fixture((_q,r)=>{
    r.writeHead(200,{'content-type':'text/event-stream'});
    r.write('event: response.output_text.delta\ndata: {"delta":"fixture"}\n\n');
  },{onUsage:record=>records.push(record)});
  try {
    const response=await request(f.base);await response.body.getReader().read();
    assert.equal(f.gateway.status().activeRequests,1);assert.equal(records.length,0);
    await f.gateway.stop();
    assert.equal(records.length,1);assert.equal(records[0].outcome,'cancelled');assert.equal(records[0].tokens,null);
    assert.equal(f.gateway.status().activeRequests,0);assert.equal(f.gateway.status().running,false);
  } finally {await f.close();}
});

test('Claude desktop model list and single model metadata are authenticated, local and non-billable',async()=>{
  let calls=0,keyReads=0;const records=[];
  const f=await fixture((_q,r)=>{calls++;r.end('{}');},{getSecret:()=>{keyReads++;return 'vendor-fixture-key';},onUsage:row=>records.push(row)});
  try {
    assert.equal((await fetch(f.base+'/claude-desktop/v1/models')).status,401);
    const headers={'x-api-key':token,'anthropic-version':'2023-06-01'};
    assert.equal((await fetch(f.base+'/claude-desktop/v1/models',{headers})).status,503);
    f.gateway.setRoute('claudeDesktop','d');const readsBefore=keyReads;
    const listResponse=await fetch(f.base+'/claude-desktop/v1/models?limit=100',{headers});
    assert.equal(listResponse.status,200);assert.equal(listResponse.headers.get('cache-control'),'no-store');
    const list=await listResponse.json();
    assert.deepEqual(list,{data:[{id:'model-d',type:'model',display_name:'model-d',created_at:'1970-01-01T00:00:00Z'}],has_more:false,first_id:'model-d',last_id:'model-d'});
    const one=await fetch(f.base+'/claude-desktop/v1/models/model-d?beta=true',{headers});
    assert.equal(one.status,200);assert.deepEqual(await one.json(),list.data[0]);
    const paginated=await fetch(f.base+'/claude-desktop/v1/models?after_id=model-d',{headers});
    assert.deepEqual(await paginated.json(),{data:[],has_more:false,first_id:null,last_id:null});
    assert.equal((await fetch(f.base+'/claude-desktop/v1/models/model-c',{headers})).status,404);
    for(const query of ['?limit=0','?limit=1001','?limit=1&limit=2','?before_id=unknown','?arbitrary=1']) {
      assert.equal((await fetch(f.base+'/claude-desktop/v1/models'+query,{headers})).status,400);
    }
    assert.equal((await request(f.base,'/claude-desktop/v1/models')).status,405);
    assert.equal((await fetch(f.base+'/claude-desktop/v1/models',{headers:{...headers,origin:'https://example.com'}})).status,401);
    assert.equal(keyReads,readsBefore);assert.equal(calls,0);assert.equal(records.length,0);
    assert.equal(f.gateway.status().requestCounts.claudeDesktop,0);assert.equal(f.gateway.status().desktopSuccessCount,0);
    assert.equal(f.gateway.status().lastDesktopRequestAt,undefined);assert.equal(f.gateway.status().lastDesktopModel,undefined);
    assert.equal(f.gateway.status().routes.claude,'c');assert.equal(f.gateway.status().routes.claudeDesktop,'d');
    assert.throws(()=>f.gateway.setRoute('claudeDesktop','a'),/不匹配/);
  } finally {await f.close();}
});

test('Claude desktop streams tool use unchanged with independent CLI route, price snapshot and shared billing engine',async()=>{
  const records=[],got=[];let finish;
  const start='event: message_start\ndata: {"type":"message_start","message":{"id":"fixture-message","type":"message","model":"canonical-model-d","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}\n\n';
  const tool='event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-fixture","name":"read_file","input":{}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"demo.txt\\"}"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
  const end='event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const f=await fixture(async(q,r)=>{
    const chunks=[];for await(const chunk of q)chunks.push(chunk);
    got.push({url:q.url,headers:q.headers,body:JSON.parse(Buffer.concat(chunks).toString())});
    if(q.url.startsWith('/anthropic-desktop/')) {r.writeHead(200,{'content-type':'text/event-stream','request-id':'desktop-fixture-request'});r.write(start);finish=()=>r.end(tool+end);}
    else {r.writeHead(200,{'content-type':'application/json'});r.end('{"type":"message","model":"model-e","usage":{"input_tokens":2,"output_tokens":3}}');}
  },{onUsage:row=>records.push(row)});
  f.connections.d.pricing={currency:'CNY',inputPerMillion:1,outputPerMillion:2,cacheReadPerMillion:.1,cacheWritePerMillion:1.25,source:'before request'};
  try {
    f.gateway.setRoute('claudeDesktop','d');f.gateway.pause('claude');
    const body={model:'desktop-client-alias',messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'previous-call',content:'file-fixture'}]}],stream:true,max_tokens:64,tools:[{name:'read_file',description:'fixture tool',input_schema:{type:'object',properties:{path:{type:'string'}}}}],tool_choice:{type:'auto'}};
    const response=await fetch(f.base+'/claude-desktop/v1/messages?beta=true',{method:'POST',headers:{'x-api-key':token,'content-type':'application/json','anthropic-version':'2023-06-01','anthropic-beta':'tool-fixture-beta','x-stainless-lang':'js'},body:JSON.stringify(body)});
    const reader=response.body.getReader();let received=Buffer.from((await reader.read()).value).toString();
    assert.equal(received,start);assert.equal(response.headers.get('request-id'),'desktop-fixture-request');assert.equal(records.length,0);
    assert.equal(f.gateway.activeRequestsFor('claudeDesktop'),1);assert.equal(f.gateway.activeRequestsFor('claude'),0);
    assert.equal((await request(f.base,'/claude/v1/messages')).status,503);
    f.gateway.setRoute('claude','e');f.gateway.resume('claude');
    assert.throws(()=>f.gateway.setRoute('claudeDesktop','e'),/执行中/);assert.throws(()=>f.gateway.clearRoute('claudeDesktop'),/执行中/);assert.throws(()=>f.gateway.pause('claudeDesktop'),/执行中/);
    await (await request(f.base,'/claude/v1/messages')).text();
    f.connections.d.pricing.outputPerMillion=8;f.connections.d.pricing.source='after request';
    finish();for(;;){const chunk=await reader.read();if(chunk.done)break;received+=Buffer.from(chunk.value).toString();}
    assert.equal(received,start+tool+end);assert.equal(got.length,2);
    assert.equal(got[0].url,'/anthropic-desktop/v1/messages?beta=true');assert.equal(got[0].headers.authorization,'Bearer vendor-fixture-key');assert.equal(got[0].headers['x-api-key'],'vendor-fixture-key');
    assert.equal(got[0].headers['anthropic-beta'],'tool-fixture-beta');assert.equal(got[0].headers['anthropic-version'],'2023-06-01');assert.equal(got[0].headers['x-stainless-lang'],'js');
    assert.deepEqual(got[0].body,{...body,model:'model-d'});assert.equal(got[1].body.model,'model-e');
    const desktopRecord=records.find(row=>row.surface==='desktop'),cliRecord=records.find(row=>row.surface==='cli');
    assert.equal(records.length,2);assert.equal(desktopRecord.engine,'claude');assert.equal(desktopRecord.connectionId,'d');assert.equal(desktopRecord.model,'canonical-model-d');assert.equal(desktopRecord.tokens.inputTokens,35);assert.equal(desktopRecord.tokens.outputTokens,7);
    assert.equal(desktopRecord.pricing.outputPerMillion,2);assert.equal(desktopRecord.pricing.source,'before request');assert.equal(cliRecord.connectionId,'e');
    assert.doesNotMatch(JSON.stringify(records),/file-fixture|read_file|demo\.txt|vendor-fixture-key|desktop-client-alias/);
    const status=f.gateway.status();assert.equal(status.requestCounts.claude,2);assert.equal(status.requestCounts.claudeDesktop,1);assert.equal(status.desktopSuccessCount,1);assert.equal(status.lastDesktopModel,'model-d');assert.ok(Number.isFinite(Date.parse(status.lastDesktopRequestAt)));assert.equal(status.activeRequests,0);
    f.gateway.pause('claudeDesktop');assert.equal((await request(f.base,'/claude-desktop/v1/messages')).status,503);
    await (await request(f.base,'/claude/v1/messages')).text();f.gateway.resume('claudeDesktop');
    f.gateway.setRoute('claudeDesktop','e');assert.equal(f.gateway.status().desktopSuccessCount,0);assert.equal(f.gateway.status().lastDesktopModel,undefined);assert.equal(f.gateway.status().routes.claude,'e');
    f.gateway.clearRoute('claudeDesktop');assert.equal(f.gateway.status().routes.claude,'e');assert.equal(f.gateway.status().routes.claudeDesktop,undefined);
  } finally {await f.close();}
});

test('a CLI request does not prevent configuring or pausing the desktop route',async()=>{
  let finish,arrived;const ready=new Promise(resolve=>arrived=resolve);
  const f=await fixture((_q,r)=>{r.writeHead(200,{'content-type':'application/json'});finish=()=>r.end('{"model":"model-c","usage":{"input_tokens":1,"output_tokens":2}}');arrived();});
  try {
    const task=request(f.base,'/claude/v1/messages');await ready;
    assert.equal(f.gateway.activeRequestsFor('claude'),1);assert.equal(f.gateway.activeRequestsFor('claudeDesktop'),0);
    f.gateway.setRoute('claudeDesktop','d');f.gateway.pause('claudeDesktop');
    assert.throws(()=>f.gateway.setRoute('claude','e'),/执行中/);assert.throws(()=>f.gateway.clearRoute('claude'),/执行中/);
    assert.equal((await request(f.base,'/claude-desktop/v1/messages')).status,503);
    f.gateway.clearRoute('claudeDesktop');f.gateway.resume('claudeDesktop');
    assert.equal(f.gateway.status().routes.claude,'c');assert.equal(f.gateway.status().routes.claudeDesktop,undefined);
    finish();await (await task).text();assert.equal(f.gateway.status().activeRequests,0);
  } finally {await f.close();}
});

test('desktop success requires known usage and a complete response even without an accounting callback',async()=>{
  let mode='malformed';
  const f=await fixture((_q,r)=>{
    if(mode==='incomplete') {r.writeHead(200,{'content-type':'text/event-stream'});r.end('event: message_start\ndata: {"type":"message_start","message":{"model":"model-d","usage":{"input_tokens":1,"output_tokens":0}}}\n\n');return;}
    r.writeHead(200,{'content-type':'application/json'});
    r.end(mode==='malformed'?'{"usage":{}}':'{"type":"message","model":"canonical-model-d","usage":{"input_tokens":1,"output_tokens":2}}');
  });
  try {
    f.gateway.setRoute('claudeDesktop','d');
    for(mode of ['malformed','incomplete']) {await (await request(f.base,'/claude-desktop/v1/messages')).text();assert.equal(f.gateway.status().desktopSuccessCount,0);}
    mode='complete';await (await request(f.base,'/claude-desktop/v1/messages')).text();
    assert.equal(f.gateway.status().desktopSuccessCount,1);assert.equal(f.gateway.status().lastDesktopModel,'model-d');
  } finally {await f.close();}
});

test('desktop verification excludes catalog, count_tokens, HTTP failures, HTTP 200 errors and cancelled streams',async()=>{
  const records=[];let mode='count';
  const f=await fixture((_q,r)=>{
    if(mode==='sse') {r.writeHead(200,{'content-type':'text/event-stream'});r.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}\n\n');return;}
    if(mode==='sse-error') {r.writeHead(200,{'content-type':'text/event-stream'});r.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');return;}
    r.writeHead(mode==='http-error'?429:200,{'content-type':'application/json'});
    r.end(mode==='success'?'{"type":"message","model":"model-d","usage":{"input_tokens":2,"output_tokens":3}}':mode==='count'?'{"input_tokens":2}':'{"type":"error","error":{"type":"rate_limit_error"}}');
  },{onUsage:row=>records.push(row)});
  try {
    f.gateway.setRoute('claudeDesktop','d');
    await (await fetch(f.base+'/claude-desktop/v1/models',{headers:{'x-api-key':token}})).text();
    await (await request(f.base,'/claude-desktop/v1/messages/count_tokens')).text();
    for(mode of ['http-error','json-error','sse-error'])await (await request(f.base,'/claude-desktop/v1/messages')).text();
    assert.equal(f.gateway.status().desktopSuccessCount,0);assert.equal(f.gateway.status().lastDesktopRequestAt,undefined);
    assert.equal(records.length,3);assert.ok(records.every(row=>row.outcome==='error'&&row.surface==='desktop'&&row.engine==='claude'));
    mode='sse';const response=await request(f.base,'/claude-desktop/v1/messages');await response.body.getReader().read();
    await f.gateway.stop();assert.equal(records.length,4);assert.equal(records[3].outcome,'cancelled');assert.equal(records[3].tokens,null);assert.equal(f.gateway.status().desktopSuccessCount,0);
    await f.gateway.start();f.base=f.gateway.status().baseUrl;mode='success';await (await request(f.base,'/claude-desktop/v1/messages')).text();
    assert.equal(f.gateway.status().desktopSuccessCount,1);assert.equal(records.length,5);assert.equal(records[4].outcome,'success');
  } finally {await f.close();}
});
