import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { safeStorage } from 'electron';
import * as TOML from '@iarna/toml';
import { WorkbenchServices, connectionConfigurationIssue } from './services';
import { UsageLedger } from './usage';
import { LocalGateway, type GatewayRoute } from './gateway';
import { CodexDesktopAdapter } from './codex-desktop';
import { ClaudeDesktopAdapter, buildClaudeVSCodeSettings } from './claude-desktop';
import { ClaudeGuiAdapter, claudeGuiModelIssue } from './claude-gui';
import { detectDesktops, launchCodexDesktop, launchClaudeTerminal, launchClaudeGui } from './detection';
import type { AppState, AuthMode, CompanionState, ConfigPreview, ConfigResult, Engine, RuntimeDiagnostic, ToolConfigInput, ToolStatus, ClaudeGuiStatus, ClaudeGuiConfigInput, ClaudeGuiConfigPreview, ClaudeGuiConfigResult } from '../shared/types';

type RelayState = { port: number; encryptedToken: string; routes: {codex?:string;claude?:string;claudeDesktop?:string} };
export class ConnectionManager {
  readonly services: WorkbenchServices;
  readonly gateway: LocalGateway;
  readonly usage: UsageLedger;
  private relay: RelayState;
  private token: string;
  private relayFile: string;
  private codexAdapter?: CodexDesktopAdapter;
  private claudeAdapter?: ClaudeDesktopAdapter;
  private claudeGuiAdapter?: ClaudeGuiAdapter;
  private claudeGuiPath = '';
  private claudeGuiRunning = false;
  private claudeGuiSchemaSupported = false;
  private claudeGuiVersion?: string;
  private diagnostic: RuntimeDiagnostic[] = [];
  private previews = new Map<Engine,{input:string;fingerprint:string;connectionFingerprint:string;codexId?:string}>();
  private guiPreview?: {input:string;fingerprint:string;connectionFingerprint:string};
  private mutation = false;
  private backupRoutes:Record<string,{engine:Engine;route?:string;surface?:'desktop'}> = {};
  get isMutating():boolean{return this.mutation;}
  constructor(readonly dataDir: string, onChange?:()=>void) {
    this.usage = new UsageLedger(dataDir);
    this.services = new WorkbenchServices(dataDir, capture => {
      this.usage.record(capture, capture.pricing);
      onChange?.();
    });
    const routesFile=path.join(dataDir,'backup-routes.json');
    if(fs.existsSync(routesFile))this.backupRoutes=JSON.parse(fs.readFileSync(routesFile,'utf8'));
    this.relayFile = path.join(dataDir,'gateway.local.json');
    this.relay = { port: 53187, encryptedToken: '', routes:{} };
    if (fs.existsSync(this.relayFile)) this.relay = JSON.parse(fs.readFileSync(this.relayFile,'utf8'));
    if (!Number.isInteger(this.relay.port) || this.relay.port<1024 || this.relay.port>65535) throw new Error('网关端口配置无效。');
    this.token = '';
    if (this.relay.encryptedToken && safeStorage.isEncryptionAvailable()) {
      try { this.token=safeStorage.decryptString(Buffer.from(this.relay.encryptedToken,'base64')); } catch { /* Reapply routing after a machine change. */ }
    }
    if (!this.token) { this.token=randomBytes(32).toString('hex'); this.relay.encryptedToken=safeStorage.isEncryptionAvailable()?safeStorage.encryptString(this.token).toString('base64'):''; this.persistRelay(); }
    this.gateway = new LocalGateway({token:this.token,port:this.relay.port,getConnection:id=>this.services.getConnection(id),getSecret:id=>this.services.getSecret(id),onChange,
      onUsage: capture => { this.usage.record(capture, capture.pricing); onChange?.(); }});
    for (const engine of ['codex','claude','claudeDesktop'] as const) {
      const id=this.relay.routes[engine]; if(id) {try{this.gateway.setRoute(engine,id);}catch{delete this.relay.routes[engine];}}
    }
  }
  private persistRelay(): void {
    const tmp=this.relayFile+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(this.relay,null,2),{mode:0o600});fs.renameSync(tmp,this.relayFile);
  }
  private persistBackupRoutes():void {
    const filename=path.join(this.dataDir,'backup-routes.json'),tmp=filename+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(this.backupRoutes,null,2));fs.renameSync(tmp,filename);
  }
  private async mutate<T>(engine:GatewayRoute,action:()=>Promise<T>):Promise<T> {
    if(this.mutation)throw new Error('另一个配置操作正在进行，请稍后重试。');
    this.mutation=true;
    try{await this.mutationGuard(engine);this.gateway.pause(engine);return await action();}
    finally{this.gateway.resume(engine);this.mutation=false;}
  }
  private get codex(): CodexDesktopAdapter {
    const desired = path.resolve(this.services.getSettings().codexConfigPath || path.join(os.homedir(),'.codex','config.toml'));
    if(!this.codexAdapter || this.codexAdapter.configPath!==desired) this.codexAdapter=new CodexDesktopAdapter({configPath:desired,backupDir:path.join(this.dataDir,'config-backups','codex'),catalogDir:path.join(this.dataDir,'catalogs')});
    return this.codexAdapter;
  }
  private get claude(): ClaudeDesktopAdapter {
    const desired = path.resolve(this.services.getSettings().claudeConfigPath || path.join(os.homedir(),'.claude','settings.json'));
    if(!this.claudeAdapter || this.claudeAdapter.settingsPath!==desired) this.claudeAdapter=new ClaudeDesktopAdapter({settingsPath:desired,backupDir:path.join(this.dataDir,'config-backups','claude')});
    return this.claudeAdapter;
  }
  private get claudeGui(): ClaudeGuiAdapter {
    const configured = this.services.getSettings().claudeDesktopConfigDir;
    const desired = path.resolve(configured || (process.env.WORKBENCH_TEST_DATA ? path.join(this.dataDir,'fixtures','Claude-3p','configLibrary') : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'Claude-3p','configLibrary')));
    if (!this.claudeGuiAdapter || this.claudeGuiPath !== desired) {
      this.claudeGuiPath = desired;
      this.claudeGuiAdapter = new ClaudeGuiAdapter({ configLibraryPath: desired, backupDir: path.join(this.dataDir,'config-backups','claude-desktop'), isRunning: () => this.claudeGuiRunning,
        isSchemaSupported: () => (Boolean(process.env.WORKBENCH_TEST_DATA) && this.claudeGuiPath.startsWith(path.resolve(this.dataDir)+path.sep)) || this.claudeGuiSchemaSupported,
        ...(process.env.WORKBENCH_TEST_DATA ? {isPolicyManaged: () => false} : {}) });
    }
    return this.claudeGuiAdapter;
  }
  private configPath(engine: Engine): string {return engine==='codex'?this.codex.configPath:this.claude.settingsPath;}
  private fingerprint(engine: Engine): string {
    const filename=this.configPath(engine);
    return createHash('sha256').update(fs.existsSync(filename)?fs.readFileSync(filename):'missing').digest('hex');
  }
  private connectionFingerprint(input:ToolConfigInput):string {
    const c=input.connectionId?this.services.getConnection(input.connectionId):undefined;
    return createHash('sha256').update(JSON.stringify(c?{id:c.id,name:c.name,presetId:c.presetId,engine:c.engine,protocol:c.protocol,baseUrl:c.baseUrl,model:c.model,key:this.services.getSecret(c.id)}:{mode:input.mode})).digest('hex');
  }
  async start(): Promise<void> { await this.gateway.start(); }
  exportUsageReport(): {path:string;message:string} {
    const folder=path.join(this.dataDir,'exports'); fs.mkdirSync(folder,{recursive:true});
    const records=this.usage.records({range:'all',limit:10000}).reverse();
    const cell=(value:unknown):string=>{
      let text=String(value??'');
      if(/^\s*[=+@\-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
      return '"'+text.replace(/"/g,'""')+'"';
    };
    const headers=['时间（北京时间）','连接','工具','入口','模型','类型','结果','HTTP状态','输入Token（含缓存）','输出Token','缓存读取Token','缓存写入Token','估算费用（人民币）','单价来源'];
    const rows=records.map(record=>[
      new Date(record.finishedAt).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),record.connectionName,record.engine,record.surface==='desktop'?'Claude 桌面':record.surface==='cli'?'Claude Code CLI':'',record.model,
      record.kind==='connection-test'?'连接测试':'模型请求',record.outcome,record.httpStatus,
      record.tokens?.inputTokens,record.tokens?.outputTokens,record.tokens?.cacheReadTokens,record.tokens?.cacheWriteTokens,
      record.costCNY===null?'未计价':record.costCNY.toFixed(8),record.pricing?.source||''
    ].map(cell).join(','));
    const filename=path.join(folder,`usage-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`);
    fs.writeFileSync(filename,'\uFEFF'+[headers.map(cell).join(','),...rows].join('\r\n'),'utf8');
    return {path:filename,message:`已导出最近 ${records.length} 条调用记录（最多 10000 条）。金额为本机估算；未计价记录保留标记。`};
  }
  async diagnose(): Promise<RuntimeDiagnostic[]> { this.diagnostic=await this.services.diagnose();return this.diagnostic; }
  async getToolState(): Promise<CompanionState> {
    const detection=await detectDesktops();
    const settings=this.services.getSettings();
    const tools: ToolStatus[]=[];
    for(const engine of ['codex','claude'] as const) {
      const configPath=this.configPath(engine), configExists=fs.existsSync(configPath);
      let mode:ToolStatus['mode']='unknown', message='配置来源未确认；不会读取会员凭据。';
      try {
        const content=configExists?fs.readFileSync(configPath,'utf8'):'';
        if(engine==='codex') {
          const parsed=TOML.parse(content) as any;
          if(parsed.model_provider==='continuation_workbench') {mode='api';message='已检测到管理器网关配置。请在官方应用确认选中的模型和供应商。';}
          else if(!parsed.model_provider || parsed.model_provider==='openai') {mode='subscription';message='配置使用 OpenAI 默认供应商；登录方式与会员额度请在官方应用确认。';}
        } else {
          const parsed=content?JSON.parse(content):{};
          if(String(parsed.env?.ANTHROPIC_BASE_URL || '').replace(/\/$/,'')===this.gateway.status().baseUrl+'/claude') {mode='api';message='已检测到本机网关配置。CLI/编辑器需重新启动；项目或组织策略可能覆盖用户配置。';}
          else if(!parsed.apiKeyHelper&&!parsed.env?.ANTHROPIC_BASE_URL&&!parsed.env?.ANTHROPIC_API_KEY&&!parsed.env?.ANTHROPIC_AUTH_TOKEN&&!['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'].some(k=>parsed.env?.[k]&&parsed.env[k]!=='0')) {mode='subscription';message='未检测到 API 路由；登录状态请在官方 Claude Code 确认。';}
        }
      } catch {message='配置文件解析失败，请先在原工具修复；管理器未修改文件。';}
      const executablePath=engine==='codex'?(settings.codexDesktopPath||detection.codexPath):(settings.claudePath||this.diagnostic.find(item=>item.engine==='claude'&&item.available)?.path||'');
      tools.push({engine,configPath,executablePath,configExists,mode,running:engine==='codex'?detection.codexRunning:detection.claudeRunning,
        activeConnectionId:mode==='api'?this.gateway.status().routes[engine]:undefined,message});
    }
    const [codexBackups,claudeBackups]=await Promise.all([this.codex.listBackups(),Promise.resolve(this.claude.listBackups())]);
    return {tools,gateway:this.gateway.status(),backups:[...codexBackups,...claudeBackups].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),claudeDesktop:await this.getClaudeDesktopState()};
  }
  async state(): Promise<AppState> {
    return {projects:[],sessions:[],checkpoints:[],connections:this.services.getConnections(),presets:this.services.getPresets(),settings:this.services.getSettings(),diagnostics:this.diagnostic,dataDir:this.dataDir,companion:await this.getToolState()};
  }
  private connection(input:ToolConfigInput) {
    if(!['codex','claude'].includes(input.engine)||!['api','subscription'].includes(input.mode)) throw new Error('工作台或模式无效。');
    if(input.mode==='subscription') return undefined;
    const c=input.connectionId?this.services.getConnection(input.connectionId):undefined;
    if(!c||c.engine!==input.engine)throw new Error('请选择与工作台匹配的 API 连接。');
    const issue=connectionConfigurationIssue(c);if(issue)throw new Error(issue);
    if((input.engine==='codex'&&c.protocol!=='responses')||(input.engine==='claude'&&c.protocol!=='anthropic'))throw new Error('API 协议不兼容。');
    if(!c.hasKey)throw new Error('请填写 API Key；换机后需重新填写。');
    return c;
  }
  private claudeProfile(id:string) {
    const c=this.services.getConnection(id)!;
    return {connectionId:id,gatewayBaseUrl:this.gateway.status().baseUrl+'/claude',gatewayToken:this.token,model:c.model};
  }
  private claudeGuiProfile(id: string) {
    return { ...this.claudeProfile(id), gatewayBaseUrl: this.gateway.status().baseUrl + '/claude-desktop' };
  }
  async getClaudeDesktopState(): Promise<ClaudeGuiStatus> {
    const detection = await detectDesktops(); this.claudeGuiRunning = Boolean(detection.claudeDesktopRunning);
    this.claudeGuiVersion = detection.claudeDesktopVersion;
    const chosen = this.services.getSettings().claudeDesktopPath;
    this.claudeGuiSchemaSupported = detection.claudeDesktopVersion === '2.31226.1.0' && (!chosen || chosen.toLowerCase() === detection.claudeDesktopPath?.toLowerCase());
    const gateway = this.gateway.status(); const id = gateway.routes.claudeDesktop;
    const connection = id ? this.services.getConnection(id) : undefined;
    const profile = connection ? this.claudeGuiProfile(connection.id) : undefined;
    const status = this.claudeGui.getStatus(profile);
    const ours = status.mode === 'api' && profile && status.gatewayBaseUrl === profile.gatewayBaseUrl && status.model === profile.model;
    const verified = ours && (gateway.desktopSuccessCount || 0) > 0 && gateway.lastDesktopModel === profile.model;
    const connectionIssues: Record<string,string> = {};
    for (const item of this.services.getConnections().filter(item => item.engine === 'claude')) {
      const issue = claudeGuiModelIssue(item.model) || connectionConfigurationIssue(item);
      if (issue) connectionIssues[item.id] = issue;
    }
    return { ...status, executablePath: this.services.getSettings().claudeDesktopPath || detection.claudeDesktopPath || '', running: this.claudeGuiRunning,
      ...(ours ? { activeConnectionId: id } : {}), activationState: verified ? 'verified' : status.activationState,
      ...(verified ? { message: 'Claude 桌面已通过此独立网关完成模型请求；用量已记入费用统计。', lastRequestAt: gateway.lastDesktopRequestAt } : {}),
      requestCount: gateway.requestCounts.claudeDesktop || 0, backups: this.claudeGui.listBackups(), connectionIssues,
      clientVersion: this.claudeGuiVersion,
      compatibilityNote: '桌面入口配置真实 Claude 模型，自动配置已适配 2.31226.1.0；未核实的版本请用官方配置窗口。该版本会拒绝 Qwen 等非 Claude 模型；国产模型可使用 Claude Code 终端或 VS Code 官方图形扩展。' };
  }
  async previewClaudeDesktopConfig(input: ClaudeGuiConfigInput): Promise<ClaudeGuiConfigPreview> {
    const connection = this.connection({ engine: 'claude', ...input });
    if (connection) { const issue = claudeGuiModelIssue(connection.model); if (issue) throw new Error(issue); }
    await this.getClaudeDesktopState();
    const result = input.mode === 'api' ? await this.claudeGui.preview(this.claudeGuiProfile(connection!.id)) : await this.claudeGui.previewSubscription();
    this.guiPreview = { input: JSON.stringify(input), fingerprint: this.claudeGui.fingerprint(), connectionFingerprint: this.connectionFingerprint({ engine: 'claude', ...input }) };
    return result;
  }
  async applyClaudeDesktopConfig(input: ClaudeGuiConfigInput): Promise<ClaudeGuiConfigResult> {
    const connection = this.connection({ engine: 'claude', ...input }); const preview = this.guiPreview;
    if (!preview || preview.input !== JSON.stringify(input) || preview.fingerprint !== this.claudeGui.fingerprint() || preview.connectionFingerprint !== this.connectionFingerprint({ engine: 'claude', ...input })) throw new Error('桌面配置或连接已变化，请重新预览再应用。');
    if (input.mode === 'api' && !this.gateway.status().running) throw new Error('本机网关没有启动，请检查端口是否占用。');
    return this.mutate('claudeDesktop', async () => {
      if (preview.fingerprint !== this.claudeGui.fingerprint() || preview.connectionFingerprint !== this.connectionFingerprint({ engine: 'claude', ...input })) throw new Error('等待期间桌面配置或连接已变化，请重新预览。');
      const oldRoute = this.gateway.status().routes.claudeDesktop;
      const result = input.mode === 'api' ? await this.claudeGui.apply(this.claudeGuiProfile(connection!.id)) : await this.claudeGui.applySubscription();
      if (result.ok) {
        if (result.backupId) { this.backupRoutes[result.backupId] = { engine: 'claude', surface: 'desktop', route: oldRoute }; this.persistBackupRoutes(); }
        if (connection) { this.gateway.setRoute('claudeDesktop', connection.id); this.relay.routes.claudeDesktop = connection.id; }
        else { this.gateway.clearRoute('claudeDesktop'); delete this.relay.routes.claudeDesktop; }
        this.persistRelay(); this.guiPreview = undefined;
      }
      return result;
    });
  }
  async restoreClaudeDesktopConfigBackup(id?: string): Promise<ClaudeGuiConfigResult> {
    const backups = this.claudeGui.listBackups(); const backup = id ? backups.find(item => item.id === id) : backups.find(item => item.canRestore);
    if (!backup) throw new Error('没有可恢复的 Claude 桌面配置备份。');
    await this.getClaudeDesktopState();
    return this.mutate('claudeDesktop', async () => {
      const result = await this.claudeGui.restore(backup.id);
      const previous = this.backupRoutes[backup.id]?.route;
      if (previous && this.services.getConnection(previous)?.hasKey) { this.gateway.setRoute('claudeDesktop', previous); this.relay.routes.claudeDesktop = previous; }
      else { this.gateway.clearRoute('claudeDesktop'); delete this.relay.routes.claudeDesktop; }
      this.persistRelay(); this.guiPreview = undefined; return result;
    });
  }
  async launchClaudeDesktop(): Promise<ConfigResult> {
    const state = await this.getClaudeDesktopState();
    if (state.mode === 'api' && !this.gateway.status().running) throw new Error('请先启动本机网关。');
    const result = await launchClaudeGui(state.executablePath);
    return { ok: true, message: result.message, restartRequired: false };
  }
  async previewToolConfig(input:ToolConfigInput):Promise<ConfigPreview> {
    const c=this.connection(input);let result:ConfigPreview;let codexId:string|undefined;
    if(input.engine==='codex') {
      const preview=input.mode==='api'?await this.codex.previewGateway({baseUrl:this.gateway.status().baseUrl+'/codex/v1',relayToken:this.token,model:c!.model,catalogKind:c!.presetId==='deepseek'?'deepseek':'generic'}):await this.codex.previewSubscription();
      result=preview;codexId=preview.previewId;
    }else result=input.mode==='api'?await this.claude.preview(this.claudeProfile(c!.id)):await this.claude.previewSubscription();
    this.previews.set(input.engine,{input:JSON.stringify(input),fingerprint:this.fingerprint(input.engine),connectionFingerprint:this.connectionFingerprint(input),codexId});return result;
  }
  private async mutationGuard(engine:GatewayRoute):Promise<void> {
    if(this.gateway.activeRequestsFor(engine))throw new Error('此工作台还有 API 请求执行中，请停止任务或等待请求结束。');
    if (engine === 'claudeDesktop') {
      const detection = await detectDesktops(true); this.claudeGuiRunning = Boolean(detection.claudeDesktopRunning);
      const chosen = this.services.getSettings().claudeDesktopPath;
      this.claudeGuiSchemaSupported = detection.claudeDesktopVersion === '2.31226.1.0' && (!chosen || chosen.toLowerCase() === detection.claudeDesktopPath?.toLowerCase());
      const fixture = Boolean(process.env.WORKBENCH_TEST_DATA) && this.claudeGuiPath.startsWith(path.resolve(this.dataDir)+path.sep);
      if (this.claudeGuiRunning && !fixture) throw new Error('请先保存工作并完全退出 Claude 桌面应用，再应用或恢复桌面配置；续航台不会关闭你的工作台。');
      return;
    }
    // Test fixtures inside an explicit isolated data directory never affect the official app.
    const fixture=Boolean(process.env.WORKBENCH_TEST_DATA)&&this.configPath(engine).startsWith(path.resolve(this.dataDir)+path.sep);
    if(engine==='codex'&&!fixture&&(await detectDesktops(true)).codexRunning)throw new Error('请先保存工作并完全退出官方 Codex，再应用或回滚配置；管理器不会关闭正在工作的应用。');
  }
  async applyToolConfig(input:ToolConfigInput):Promise<ConfigResult> {
    const c=this.connection(input), preview=this.previews.get(input.engine);
    if(!preview||preview.input!==JSON.stringify(input)||preview.fingerprint!==this.fingerprint(input.engine)||preview.connectionFingerprint!==this.connectionFingerprint(input))throw new Error('请先重新预览配置，再应用；当前文件、连接或密钥已变化。');
    if(input.mode==='api'&&!this.gateway.status().running)throw new Error('本机网关没有启动，请检查端口是否占用。');
    return this.mutate(input.engine,async()=>{
      if(preview.fingerprint!==this.fingerprint(input.engine)||preview.connectionFingerprint!==this.connectionFingerprint(input))throw new Error('等待期间配置或连接已变化，请重新预览。');
      this.connection(input);
      const oldRoute=this.gateway.status().routes[input.engine];
      let result:ConfigResult;
      if(input.engine==='codex')result=await this.codex.apply(preview.codexId!);
      else result=input.mode==='api'?await this.claude.apply(this.claudeProfile(c!.id)):await this.claude.applySubscription();
      if(result.ok) {
        if(result.backupId){this.backupRoutes[result.backupId]={engine:input.engine,route:oldRoute};this.persistBackupRoutes();}
        if(c) {this.gateway.setRoute(input.engine,c.id);this.relay.routes[input.engine]=c.id;}
        else {this.gateway.clearRoute(input.engine);delete this.relay.routes[input.engine];}
        this.persistRelay();this.previews.delete(input.engine);
      }
      return result;
    });
  }
  async switchRoute(input:{engine:Engine;connectionId:string}):Promise<ConfigResult> {
    this.connection({...input,mode:'api'});
    const tool=(await this.getToolState()).tools.find(item=>item.engine===input.engine);
    if(tool?.mode!=='api')throw new Error('请先预览并应用本机网关配置。');
    const currentId=this.gateway.status().routes[input.engine];
    const current=currentId?this.services.getConnection(currentId):undefined,next=this.services.getConnection(input.connectionId)!;
    // Codex tool metadata is read by the official client at startup. Switching catalog families needs a restart.
    if(input.engine==='codex'&&current&&((current.presetId==='deepseek')!==(next.presetId==='deepseek')))throw new Error('此次切换需要更换 Codex 模型工具配置。请使用“预览配置→应用配置”，然后重启官方应用。');
    this.gateway.setRoute(input.engine,input.connectionId);this.relay.routes[input.engine]=input.connectionId;this.persistRelay();
    return {ok:true,message:'API 路由已切换，后续请求使用所选供应商；已发出的请求不会重放。原工作台的模型名称可能保留旧显示。',restartRequired:false};
  }
  async restoreConfigBackup(id:string):Promise<ConfigResult> {
    const backup=(await this.getToolState()).backups.find(item=>item.id===id);if(!backup)throw new Error('配置备份不存在。');
    return this.mutate(backup.engine,async()=>{
      const result=backup.engine==='codex'?await this.codex.rollback(id):await this.claude.restore(id);
      const tool=(await this.getToolState()).tools.find(item=>item.engine===backup.engine);
      const previous=this.backupRoutes[id]?.route;
      if(tool?.mode==='api'&&previous&&this.services.getConnection(previous)?.hasKey){this.gateway.setRoute(backup.engine,previous);this.relay.routes[backup.engine]=previous;}
      else {this.gateway.clearRoute(backup.engine);delete this.relay.routes[backup.engine];if(tool?.mode==='api')result.message+=' 原连接无法确认，请先选择 API 路由；网关已暂停该工作台的转发。';}
      this.persistRelay();this.previews.delete(backup.engine);return result;
    });
  }
  async launchTool(input:{engine:Engine;directory?:string}):Promise<ConfigResult> {
    const tool=(await this.getToolState()).tools.find(item=>item.engine===input.engine);if(!tool)throw new Error('工作台无效。');
    if(tool.mode==='api'&&!this.gateway.status().running)throw new Error('请先启动本机网关。');
    const result=input.engine==='codex'?await launchCodexDesktop(tool.executablePath):await launchClaudeTerminal(tool.executablePath,input.directory||this.services.getSettings().claudeLaunchDirectory||os.homedir(),path.join(this.dataDir,'launch-status'));
    return {ok:true,message:result.message,restartRequired:false};
  }
  exportBackup():{path:string;message:string} {
    const folder=path.join(this.dataDir,'exports');fs.mkdirSync(folder,{recursive:true});
    const filename=path.join(folder,`connections-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    const connections=this.services.getConnections().map(({maskedKey,hasKey,testMessage,...c})=>({...c,hasKey:false,testStatus:'untested'}));
    fs.writeFileSync(filename,JSON.stringify({format:'continuation-connections',version:1,exportedAt:new Date().toISOString(),connections,settings:this.services.getSettings(),note:'不含供应商密钥、会员凭据、本机网关令牌和加密原配置。换机需重新填写密钥并重新应用。'},null,2));
    return {path:filename,message:'已导出无密钥连接清单；加密原配置与会员凭据未导出。'};
  }
  exportVSCodeConfig(connectionId:string):{path:string;message:string} {
    this.connection({engine:'claude',mode:'api',connectionId});
    const folder=path.join(this.dataDir,'exports');fs.mkdirSync(folder,{recursive:true});
    const filename=path.join(folder,'claude-vscode-gateway.json');
    fs.writeFileSync(filename,JSON.stringify(buildClaudeVSCodeSettings(this.claudeProfile(connectionId)),null,2),{mode:0o600});
    return {path:filename,message:'已导出本机网关配置片段。合并 claudeCode.environmentVariables 到原 VS Code 扩展的用户设置，重新启动 VS Code；请先在管理器应用 Claude API 配置以选定转发路由。片段只含本机令牌，供应商密钥没有导出。'};
  }
}
