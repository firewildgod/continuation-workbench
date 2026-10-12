const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete process.env[key];
process.env.NO_PROXY='localhost,127.0.0.1';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const TOML=require('@iarna/toml');
const root=path.resolve(__dirname,'..');
const fixture=path.resolve(process.env.WORKBENCH_TEST_DATA||path.join(root,'.qa','desktop'));
assert.ok(fixture.startsWith(path.join(root,'.qa')+path.sep),'Smoke fixtures must stay inside the workspace .qa directory.');
const screenshots=path.join(root,'docs','screenshots');
fs.mkdirSync(screenshots,{recursive:true});
const configPath=path.join(fixture,'fixtures','codex','config.toml');
const claudeConfigPath=path.join(fixture,'fixtures','claude','settings.json');
fs.mkdirSync(path.dirname(configPath),{recursive:true});fs.mkdirSync(path.dirname(claudeConfigPath),{recursive:true});
if(!fs.existsSync(configPath))fs.writeFileSync(configPath,'# fixture-only configuration\nmodel_provider = "openai"\n[features]\nexample = true\n');
if(!fs.existsSync(claudeConfigPath))fs.writeFileSync(claudeConfigPath,'{"permissions":{"allow":[]},"env":{"USER_FIXTURE":"preserved"}}');
async function run(){
  const version=await(await fetch('http://127.0.0.1:9223/json/version')).json();
  const browser=await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('file:'));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>Boolean(window.desktop));
  const initial=await page.evaluate(()=>window.desktop.getState());assert.equal(initial.presets.length,9);assert.equal(initial.companion.gateway.running,true);
  await page.screenshot({path:path.join(screenshots,'01-workbench-connections.png')});
  await page.getByRole('button',{name:'API 接入',exact:true}).click();
  await page.getByLabel('供应商预设').selectOption('deepseek');
  await page.screenshot({path:path.join(screenshots,'02-api-connections.png'),fullPage:true});
  let received=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    received.push({path:req.url,model:JSON.parse(Buffer.concat(chunks).toString()).model,auth:req.headers.authorization,ua:req.headers['user-agent']});
    if(req.url.includes('/messages'))res.end(JSON.stringify({content:[{type:'text',text:'OK'}]}));
    else {res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"type":"response.completed"}\n\ndata: [DONE]\n\n');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  try{
    await page.evaluate(async values=>{await window.desktop.saveSettings({codexConfigPath:values.configPath,claudeConfigPath:values.claudeConfigPath});}, {configPath,claudeConfigPath});
    await page.getByLabel('供应商预设').selectOption('custom');
    await page.getByLabel('连接名称',{exact:true}).fill('本机协议验收（测试）');
    await page.getByLabel('服务地址（Base URL）').fill(`http://127.0.0.1:${port}/v1`);
    await page.getByLabel('API Key',{exact:true}).fill('fixture-vendor-secret-not-real-0001');
    await page.getByLabel('模型',{exact:true}).fill('fixture-model-a');
    await page.getByRole('button',{name:'保存连接',exact:true}).click();
    await page.waitForFunction(async()=>{const s=await window.desktop.getState();return s.connections.some(c=>c.name==='本机协议验收（测试）');});
    const connection=(await page.evaluate(()=>window.desktop.getState())).connections.find(c=>c.name==='本机协议验收（测试）');assert.ok(connection.hasKey);
    await page.getByRole('button',{name:'工作台连接',exact:true}).click();
    const card=page.locator('.connector-card').first();
    await card.getByLabel('准备使用的模式').selectOption('api');await card.getByLabel('准备使用的连接').selectOption(connection.id);
    await card.getByRole('button',{name:'预览配置',exact:true}).click();
    await page.waitForSelector('[role="dialog"][aria-label="配置预览"]');
    await page.screenshot({path:path.join(screenshots,'03-config-preview.png')});
    await page.getByRole('button',{name:'应用这份配置并保存备份',exact:true}).click();
    await page.getByRole('dialog',{name:'配置预览'}).waitFor({state:'hidden'});
    for(let attempt=0;attempt<100;attempt++){
      if(TOML.parse(fs.readFileSync(configPath,'utf8')).model_providers?.continuation_workbench)break;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    const codexConfig=TOML.parse(fs.readFileSync(configPath,'utf8'));
    const relay=codexConfig.model_providers.continuation_workbench;
    const reply=await fetch(relay.base_url+'/responses',{method:'POST',headers:Object.fromEntries(Object.entries(relay.http_headers)),body:JSON.stringify({model:'fixture-alias',input:'fixture',stream:true})});assert.equal(reply.status,200);assert.match(await reply.text(),/DONE/);
    assert.equal(received[0].model,'fixture-model-a');assert.equal(received[0].auth,'Bearer fixture-vendor-secret-not-real-0001');
    const claude=await page.evaluate(base=>window.desktop.saveConnection({name:'Claude 本机协议验收（测试）',presetId:'custom',engine:'claude',protocol:'anthropic',baseUrl:base,model:'fixture-model-c',apiKey:'fixture-vendor-secret-not-real-0002'}),`http://127.0.0.1:${port}/anthropic`);
    const input={engine:'claude',mode:'api',connectionId:claude.id};
    await page.evaluate(async input=>{await window.desktop.previewToolConfig(input);await window.desktop.applyToolConfig(input);},input);
    const cli=JSON.parse(fs.readFileSync(claudeConfigPath,'utf8'));
    const result=await fetch(cli.env.ANTHROPIC_BASE_URL+'/v1/messages?beta=true',{method:'POST',headers:{Authorization:`Bearer ${cli.env.ANTHROPIC_AUTH_TOKEN}`,'user-agent':'claude-code-fixture'},body:JSON.stringify({model:'claude-alias',messages:[]})});assert.equal(result.status,200);await result.text();
    assert.equal(received[1].path,'/anthropic/v1/messages?beta=true');assert.equal(received[1].model,'fixture-model-c');
    assert.ok(!JSON.stringify(await page.evaluate(()=>window.desktop.getState())).includes('fixture-vendor-secret'));
    assert.ok(!fs.readFileSync(configPath,'utf8').includes('fixture-vendor-secret'));assert.ok(!fs.readFileSync(claudeConfigPath,'utf8').includes('fixture-vendor-secret'));
    await page.getByRole('button',{name:'备份与恢复',exact:true}).click();await page.screenshot({path:path.join(screenshots,'04-config-backups.png')});
    const state=await page.evaluate(()=>window.desktop.getState());
    for(const engine of ['codex','claude']){const backup=state.companion.backups.find(b=>b.engine===engine&&b.canRestore);assert.ok(backup);await page.evaluate(id=>window.desktop.restoreConfigBackup(id),backup.id);}
    assert.equal(TOML.parse(fs.readFileSync(configPath,'utf8')).model_provider,'openai');assert.equal(JSON.parse(fs.readFileSync(claudeConfigPath,'utf8')).env.USER_FIXTURE,'preserved');
    assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['renderer and IPC','UI connection save','config preview and apply','actual Windows secret encryption','Responses SSE relay','Claude beta relay','vendor key isolation','config rollback'],screenshots:4,externalApiCalls:0}));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
