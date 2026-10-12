import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ConnectionManager } from './manager';
import { fetchOfficialPricing } from './pricing';
import type { Engine } from '../shared/types';
import type { OfficialPricingRefreshInput, OfficialPricingResult } from '../shared/usage';

app.setName('续航台');
const root = process.env.WORKBENCH_TEST_DATA ? path.resolve(process.env.WORKBENCH_TEST_DATA) :
  process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(process.cwd()));
const dataDir = process.env.WORKBENCH_TEST_DATA ? root : path.join(root,'data');
fs.mkdirSync(dataDir,{recursive:true});
app.setPath('userData',path.join(dataDir,'electron'));
app.setPath('sessionData',path.join(dataDir,'electron','session'));
if(process.env.WORKBENCH_UI_TEST==='1'){
  const debugPort=process.env.WORKBENCH_DEBUG_PORT||'9223';
  if(!/^\d+$/.test(debugPort)||Number(debugPort)<1024||Number(debugPort)>65535)throw new Error('验收调试端口无效。');
  app.commandLine.appendSwitch('remote-debugging-port',debugPort);app.disableHardwareAcceleration();
}
const lock=app.requestSingleInstanceLock();
if(!lock)app.quit();
let window:BrowserWindow|undefined;let tray:Tray|undefined;let manager:ConnectionManager;let quitting=false;
let refreshingPrices=false;
const handle=(name:string,fn:(...args:any[])=>any)=>ipcMain.handle(`desktop:${name}`,async(event,...args)=>{
  if(!window||event.sender.id!==window.webContents.id)throw new Error('未授权的窗口请求。');
  try{return await fn(...args);}catch(error){throw new Error(error instanceof Error?error.message:'操作失败，请检查配置。');}
});
function register():void {
  handle('getUsageSummary',()=>({...manager.usage.summary(),warning:manager.usage.getError()}));
  handle('getUsageRecords',query=>manager.usage.records(query));
  handle('savePricing',input=>{
    if(manager.isMutating)throw new Error('正在应用配置，请稍后修改单价。');
    return manager.services.savePricing(input.connectionId,input.pricing);
  });
  handle('refreshOfficialPricing',async(input:OfficialPricingRefreshInput={})=>{
    if(manager.isMutating)throw new Error('正在应用配置，请稍后更新单价。');
    if(refreshingPrices)throw new Error('正在联网核对价格，请等待这次更新完成。');
    if(input.connectionIds!==undefined&&(!Array.isArray(input.connectionIds)||input.connectionIds.length>10000||input.connectionIds.some(id=>typeof id!=='string')))throw new Error('价格更新连接列表无效。');
    if(input.forceManual!==undefined&&typeof input.forceManual!=='boolean')throw new Error('价格更新模式无效。');
    const targets=manager.services.getPricingTargets(input.connectionIds);
    const eligible=targets.filter(target=>input.forceManual||target.pricingMode!=='manual');
    const skipped:OfficialPricingResult[]=targets.filter(target=>!input.forceManual&&target.pricingMode==='manual').map(target=>({connectionId:target.connectionId,status:'manual-skipped',message:'保留手工单价；可对该连接主动选择使用官方报价。',pricing:target.pricing}));
    refreshingPrices=true;
    try{
      let results:OfficialPricingResult[];
      try{results=eligible.length?await fetchOfficialPricing(eligible):[];}
      catch{results=eligible.map(target=>({connectionId:target.connectionId,status:'failed',message:'官方价格页面暂时无法读取，保留原报价。'}));}
      if(manager.isMutating)throw new Error('正在应用配置，原报价已保留，请稍后重新更新。');
      return manager.services.applyOfficialPricing([...results,...skipped],targets,Boolean(input.forceManual));
    }finally{refreshingPrices=false;}
  });
  handle('exportUsageReport',()=>manager.exportUsageReport());
  handle('getState',()=>manager.state());handle('getToolState',()=>manager.getToolState());
  handle('diagnose',()=>manager.diagnose());
  handle('chooseFolder',async()=>{const result=await dialog.showOpenDialog(window!,{properties:['openDirectory']});return result.canceled?null:result.filePaths[0];});
  handle('chooseExecutable',async()=>{const result=await dialog.showOpenDialog(window!,{properties:['openFile'],filters:[{name:'Windows 程序',extensions:['exe','cmd','bat','ps1']}]});return result.canceled?null:result.filePaths[0];});
  handle('saveConnection',input=>{
    if(manager.isMutating)throw new Error('正在应用配置，请等待完成后再编辑连接。');
    const routes=manager.gateway.status().routes;
    if(input.id&&(routes.codex===input.id||routes.claude===input.id||routes.claudeDesktop===input.id)) {
      const previous=manager.services.getConnection(input.id)!;
      if(['presetId','engine','baseUrl','model','protocol'].some(key=>input[key]!==previous[key as keyof typeof previous]))throw new Error('使用中的连接不能直接改变供应商或模型，请新增连接后切换路由或重新应用配置。');
    }
    return manager.services.saveConnection(input);
  });
  handle('deleteConnection',id=>{
    if(manager.isMutating)throw new Error('正在应用配置，请等待完成后再删除连接。');
    const gateway=manager.gateway.status();
    if(gateway.routes.codex===id||gateway.routes.claude===id||gateway.routes.claudeDesktop===id)throw new Error('此连接仍被网关使用，请先切换连接或恢复原配置。');
    manager.services.deleteConnection(id);
  });
  handle('testConnection',id=>manager.services.testConnection(id));
  handle('saveSettings',input=>{if(manager.isMutating)throw new Error('正在应用配置，请等待完成后再修改设置。');return manager.services.saveSettings(input);});
  handle('previewToolConfig',input=>manager.previewToolConfig(input));
  handle('applyToolConfig',input=>manager.applyToolConfig(input));
  handle('switchRoute',input=>manager.switchRoute(input));
  handle('launchTool',input=>manager.launchTool(input));
  handle('restoreConfigBackup',id=>manager.restoreConfigBackup(id));
  handle('openConfigFolder',async(engine:Engine)=>{
    const tool=(await manager.getToolState()).tools.find(item=>item.engine===engine);if(!tool)throw new Error('工作台无效。');
    const folder=path.dirname(tool.configPath);if(!fs.existsSync(folder))throw new Error('配置目录尚不存在。');
    const error=await shell.openPath(folder);if(error)throw new Error(error);
  });
  handle('openExternal',async(raw:string)=>{
    const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password)throw new Error('只允许打开 HTTPS 官方网页链接。');
    await shell.openExternal(url.toString());
  });
  handle('exportBackup',()=>manager.exportBackup());
  handle('exportVSCodeConfig',id=>manager.exportVSCodeConfig(id));
  handle('getClaudeDesktopState',()=>manager.getClaudeDesktopState());
  handle('previewClaudeDesktopConfig',input=>manager.previewClaudeDesktopConfig(input));
  handle('applyClaudeDesktopConfig',input=>manager.applyClaudeDesktopConfig(input));
  handle('restoreClaudeDesktopConfigBackup',id=>manager.restoreClaudeDesktopConfigBackup(id));
  handle('launchClaudeDesktop',()=>manager.launchClaudeDesktop());
  handle('openClaudeDesktopConfigFolder',async()=>{
    const desktop=await manager.getClaudeDesktopState();
    let folder=desktop.configPath;
    if(!fs.existsSync(folder)||!fs.statSync(folder).isDirectory())folder=path.dirname(folder);
    if(!fs.existsSync(folder))throw new Error('Claude 桌面配置目录尚不存在；应用配置后会建立。');
    const error=await shell.openPath(folder);if(error)throw new Error(error);
  });
}
function createWindow():void {
  window=new BrowserWindow({width:1320,height:880,minWidth:920,minHeight:660,title:`续航台 · API 连接与费用${process.env.WORKBENCH_TEST_DATA?' [验收]':''}`,backgroundColor:'#f5f6f8',show:process.env.WORKBENCH_UI_TEST!=='1'||process.env.WORKBENCH_UI_VISIBLE==='1',
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:process.env.WORKBENCH_UI_TEST==='1'&&process.env.WORKBENCH_UI_VISIBLE!=='1'}});
  window.removeMenu();
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('file:'))event.preventDefault();});
  window.on('close',event=>{
    if(!quitting&&tray){event.preventDefault();window?.hide();}
  });
  window.on('closed',()=>{window=undefined;});
  void window.loadFile(path.join(__dirname,'../renderer/index.html'));
}
if(lock) {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  void app.whenReady().then(async()=>{
    manager=new ConnectionManager(dataDir,()=>{if(window&&!window.isDestroyed())window.webContents.send('engine-event',{type:'status',sessionId:'gateway',engine:'codex',data:manager?.gateway.status()});});
    let gatewayError='';
    try{await manager.start();}catch{gatewayError='本机网关未启动：53187 端口可能被另一份管理器占用。请退出重复实例后重开。';}
    await manager.diagnose();register();createWindow();
    const icon=nativeImage.createFromPath(path.resolve(__dirname,'../../assets/app-icon.png')).resize({width:32,height:32});
    if(!icon.isEmpty()) {
      tray=new Tray(icon);tray.setToolTip('续航台 · 本机 API 网关');
      tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 API 管理器',click:()=>{window?.show();window?.focus();}},{type:'separator'},{label:'退出并停止本机网关',click:()=>{quitting=true;app.quit();}}]));
      tray.on('double-click',()=>{window?.show();window?.focus();});
    }
    if(gatewayError&&window)window.webContents.once('did-finish-load',()=>window?.webContents.send('engine-event',{type:'error',sessionId:'gateway',engine:'codex',message:gatewayError}));
  }).catch(async error=>{await dialog.showMessageBox({type:'error',title:'续航台启动失败',message:error instanceof Error?error.message:'无法启动管理器。'});quitting=true;app.quit();});
  let flushing=false;
  app.on('before-quit',event=>{
    quitting=true;
    if(manager&&!flushing){
      event.preventDefault();flushing=true;
      void manager.gateway.stop().then(()=>manager.services.waitForTests()).then(()=>manager.usage.flush()).finally(()=>app.quit());
    }
  });
  app.on('window-all-closed',()=>{if(!tray)app.quit();});
}
