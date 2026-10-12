import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { safeStorage } from 'electron';
import type { ConfigBackupInfo, ClaudeGuiConfigPreview, ClaudeGuiConfigResult, ClaudeGuiStatus } from '../shared/types';

type JsonObject = Record<string, any>;
type FileRole = 'profile' | 'mode' | 'meta';
interface FileState { role: FileRole; existed: boolean; raw: string; }
interface Ownership {
  configLibraryPath: string; baselineId?: string; latestBackupId?: string;
  lastAppliedHash?: string; connectionId?: string;
}
interface Snapshot {
  id: string; engine: 'claude'; surface: 'desktop'; configLibraryPath: string;
  createdAt: string; label: string; encrypted: string; expectedHash: string;
  previousOwnership: Ownership;
}
interface Pending {
  id: string; key: string; before: FileState[]; after: FileState[];
  ownership: Ownership; connectionId?: string; public: ClaudeGuiConfigPreview;
}
export interface ClaudeGuiGatewayProfile {
  connectionId: string; gatewayBaseUrl: string; gatewayToken: string; model: string;
}
export interface ClaudeGuiCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface ClaudeGuiOptions {
  configLibraryPath?: string; backupDir: string; cipher?: ClaudeGuiCipher;
  /** Fixture callers must supply these to avoid consulting real Windows state. */
  isRunning?: () => boolean; isPolicyManaged?: () => boolean; isSchemaSupported?: () => boolean;
}
export const CLAUDE_GUI_MANAGED_ID = '9c05727f-b127-4ff2-9a44-b6cf5b3a149f';
export const CLAUDE_GUI_VERIFIED_VERSION = '2.31226.1';
const UUID = /^[a-f0-9-]{36}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const encode = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const stateHash = (files: FileState[]): string => sha(JSON.stringify(files.map(({ role, existed, raw }) => [role, existed, raw])));
const fileHash = (file: FileState): string => sha(JSON.stringify([file.existed, file.raw]));

function object(raw: string, label: string): JsonObject {
  let value: any;
  try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new Error(`${label}不是有效 JSON；未修改文件。`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须为 JSON 对象；未修改文件。`);
  return value;
}
function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[已隐藏]') : value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /key|token|secret|password|authorization|credential|cookie|headers|session/i.test(key) ? '[已隐藏]' : redact(child)]));
}
// Installed 2.31226.1 main chunk: DSe/So/ISe/Co, followed by Vpn and
// validateSessionModel. Keep the client's deny fragments, and require a concrete
// Claude route rather than a bare tier alias accepted by some client code paths.
const NON_CLAUDE_FRAGMENT = /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/i;
export function claudeGuiModelIssue(model: string): string | undefined {
  if (typeof model !== 'string' || !model.trim() || /[\s\0]/.test(model) || NON_CLAUDE_FRAGMENT.test(model) || !/claude|anthropic/i.test(model)) {
    return '当前已安装 Claude 桌面版本（已核实 2.31226.1）会拒绝此非 Claude 模型或未确认的模型路由；可以使用 Claude Code 终端或 VS Code 图形扩展；配置未修改。';
  }
  return undefined;
}
function validate(profile: ClaudeGuiGatewayProfile): void {
  let url: URL;
  try { url = new URL(profile.gatewayBaseUrl); } catch { throw new Error('Claude 桌面本机网关地址无效。'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/claude-desktop' || url.username || url.password || url.search || url.hash) {
    throw new Error('Claude 桌面接入只允许 http://127.0.0.1:端口/claude-desktop 本机网关。');
  }
  if (!profile.connectionId || !profile.gatewayToken || !profile.model.trim() || [profile.connectionId, profile.gatewayToken, profile.model].some(value => /[\r\n\0]/.test(value))) throw new Error('Claude 桌面连接、模型或本机令牌无效。');
  const issue = claudeGuiModelIssue(profile.model);
  if (issue) throw new Error(issue);
}
export function buildClaudeGuiGatewayConfig(profile: ClaudeGuiGatewayProfile): JsonObject {
  validate(profile);
  const family = profile.model.toLowerCase().match(/(?:^|[^a-z])(haiku|sonnet|opus|fable|mythos)(?:[^a-z]|$)/)?.[1];
  return {
    inferenceProvider: 'gateway', inferenceCredentialKind: 'static',
    inferenceGatewayBaseUrl: profile.gatewayBaseUrl, inferenceGatewayApiKey: profile.gatewayToken,
    inferenceGatewayAuthScheme: 'bearer', modelDiscoveryEnabled: false,
    inferenceModels: [{ name: profile.model, labelOverride: profile.model, ...(family ? { anthropicFamilyTier: family, isFamilyDefault: true } : {}) }],
  };
}

function defaultRunningCheck(): boolean {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('无法确认 Claude 桌面是否已经退出；未修改配置。');
  return /"claude\.exe"/i.test(result.stdout);
}
function defaultPolicyCheck(): boolean {
  if (process.platform !== 'win32') return false;
  // Read value NAMES only. Never read registry values, which can hold credentials.
  const script = "$ErrorActionPreference='Stop'; $ignored=@('disableAutoUpdates','autoUpdaterEnforcementHours','updateViaUpdatesHost','relaunchEnforcementHours','configRecheckIntervalMinutes','egressProxyUrl','egressProxyPacUrl'); foreach($p in @('Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude','Registry::HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Claude')) { if(Test-Path -LiteralPath $p) { foreach($n in (Get-Item -LiteralPath $p).GetValueNames()) { if($ignored -notcontains $n) { exit 2 } } } }; exit 0";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.error || (result.status !== 0 && result.status !== 2)) throw new Error('无法检查 Claude 桌面管理策略；未修改配置。');
  return result.status === 2;
}
function defaultSchemaCheck(): boolean {
  if (process.platform !== 'win32') return false;
  // Package identity/version only: no user config, application cache or credentials.
  const script = "$ErrorActionPreference='Stop'; $taskClaudePackages=@(Get-AppxPackage -Name 'Claude'); if($taskClaudePackages.Count -eq 1 -and $taskClaudePackages[0].Version.ToString() -eq '2.31226.1.0') { exit 0 }; exit 2";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return !result.error && result.status === 0;
}

/**
 * User-level Claude Desktop 3P adapter; never edits CLI settings or registry policy.
 * Schema verified against installed Claude MSIX 2.31226.1.0 app.asar:
 * .vite/build/index.chunk-EzXl5k4A.js: JF/XF/LWn use {appliedId, entries:[{id,name}]},
 * remove hybridPointer when selecting an entry, and save flat <id>.json configs.
 * .vite/build/index.pre.js: KQ resolves LOCALAPPDATA/Claude-3p; n0/r0 consult
 * claude_desktop_config.json.deploymentMode. eI in the main chunk writes that key.
 * Official location/keys: https://claude.com/docs/third-party/claude-desktop/configuration
 */
export class ClaudeGuiAdapter {
  readonly configLibraryPath: string;
  readonly configPath: string;
  readonly modePath: string;
  readonly metaPath: string;
  private readonly backupDir: string;
  private readonly ownershipPath: string;
  private readonly cipher: ClaudeGuiCipher;
  private readonly isRunning: () => boolean;
  private readonly isPolicyManaged: () => boolean;
  private readonly isSchemaSupported: () => boolean;
  private readonly pending = new Map<string, Pending>();
  private mutation = false;

  constructor(options: ClaudeGuiOptions) {
    this.configLibraryPath = path.resolve(options.configLibraryPath || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude-3p', 'configLibrary'));
    if (path.basename(this.configLibraryPath).toLowerCase() !== 'configlibrary') throw new Error('请选择 Claude-3p 的 configLibrary 目录；不能选择登录凭据或缓存文件。');
    this.configPath = path.join(this.configLibraryPath, `${CLAUDE_GUI_MANAGED_ID}.json`);
    this.metaPath = path.join(this.configLibraryPath, '_meta.json');
    this.modePath = path.join(path.dirname(this.configLibraryPath), 'claude_desktop_config.json');
    this.backupDir = path.resolve(options.backupDir);
    this.ownershipPath = path.join(this.backupDir, 'ownership.json');
    this.cipher = options.cipher || safeStorage;
    this.isRunning = options.isRunning || defaultRunningCheck;
    this.isPolicyManaged = options.isPolicyManaged || defaultPolicyCheck;
    this.isSchemaSupported = options.isSchemaSupported || defaultSchemaCheck;
  }
  private filename(role: FileRole): string { return role === 'profile' ? this.configPath : role === 'mode' ? this.modePath : this.metaPath; }
  private safeParents(filename: string): void {
    for (let directory = path.dirname(filename); ; directory = path.dirname(directory)) {
      if (fs.existsSync(directory)) {
        const stat = fs.lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Claude 桌面配置路径含链接或非目录；未修改文件。');
      }
      if (path.dirname(directory) === directory) break;
    }
  }
  private read(role: FileRole): FileState {
    const filename = this.filename(role);
    this.safeParents(filename);
    if (!fs.existsSync(filename)) return { role, existed: false, raw: '' };
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Claude 桌面配置需为不超过 2 MiB 的普通文件；未修改文件。');
    return { role, existed: true, raw: fs.readFileSync(filename, 'utf8') };
  }
  private readAll(): FileState[] { return (['profile', 'mode', 'meta'] as const).map(role => this.read(role)); }
  fingerprint(): string { return stateHash(this.readAll()); }
  getFingerprint(): string { return this.fingerprint(); }
  private parse(file: FileState): JsonObject { return file.existed ? object(file.raw, `Claude 桌面${file.role === 'meta' ? '配置索引' : file.role === 'mode' ? '部署模式配置' : '管理器配置'}`) : {}; }
  private meta(file: FileState): JsonObject {
    const value = this.parse(file);
    if (!file.existed) return { appliedId: '', entries: [] };
    if (typeof value.appliedId !== 'string' || value.appliedId !== '' && !UUID.test(value.appliedId) || !Array.isArray(value.entries) || value.entries.some((entry: any) => !entry || typeof entry !== 'object' || !UUID.test(entry.id) || typeof entry.name !== 'string')) throw new Error('Claude 桌面配置索引格式与已验证版本不匹配；未修改文件，请使用官方配置窗口。');
    if (new Set(value.entries.map((entry: any) => entry.id)).size !== value.entries.length) throw new Error('Claude 桌面配置索引含重复 ID；未修改文件。');
    if (value.appliedId && !value.entries.some((entry: any) => entry.id === value.appliedId)) throw new Error('Claude 桌面配置索引的当前 ID 不在配置列表中；未修改文件。');
    return value;
  }
  private writeAtomic(filename: string, raw: string, beforeRename?: () => void): void {
    this.safeParents(filename);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temp = `${filename}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, raw, { mode: 0o600, flag: 'wx' }); beforeRename?.(); fs.renameSync(temp, filename); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  private ownership(): Ownership {
    if (!fs.existsSync(this.ownershipPath)) return { configLibraryPath: this.configLibraryPath };
    this.safeParents(this.ownershipPath);
    const stat = fs.lstatSync(this.ownershipPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Claude 桌面归属记录不安全；未修改文件。');
    const value = object(fs.readFileSync(this.ownershipPath, 'utf8'), 'Claude 桌面归属记录') as Ownership;
    if (value.configLibraryPath !== this.configLibraryPath) throw new Error('Claude 桌面归属记录与目录不匹配；未修改文件。');
    return value;
  }
  private saveOwnership(value: Ownership): void { this.writeAtomic(this.ownershipPath, encode(value)); }
  private requireUnchanged(expected: string): void {
    if (this.fingerprint() !== expected) throw new Error('Claude 桌面配置在预览或接管后被外部修改；已停止写入，请核对后重新预览。');
  }
  private checkWritable(): void {
    this.checkSchema();
    if (this.isPolicyManaged()) throw new Error('Claude 桌面由管理策略控制，本机配置会被忽略；未修改配置。请在官方配置窗口核对。');
    if (this.isRunning()) throw new Error('请先完全退出 Claude 桌面及同名 Claude 进程，再应用或恢复桌面配置。');
  }
  private checkSchema(): void {
    if (!this.isSchemaSupported()) throw new Error('此 Claude 桌面版本的用户级配置格式尚未核实；自动写入已停止。请使用官方 Developer → Configure Third-Party Inference 窗口；配置未修改。');
  }
  private display(files: FileState[]): string {
    return encode(Object.fromEntries(files.map(file => [path.basename(this.filename(file.role)), file.existed ? redact(this.parse(file)) : '（文件不存在）'])));
  }
  private remember(key: string, before: FileState[], after: FileState[], own: Ownership, mode: 'api' | 'subscription', warnings: string[], connectionId?: string): ClaudeGuiConfigPreview {
    const id = `claude-gui-preview-${randomUUID()}`;
    const result: ClaudeGuiConfigPreview = { engine: 'claude', surface: 'desktop', mode, activationKind: 'auto', previewId: id, configPath: this.configPath, before: this.display(before), after: this.display(after), warnings, changed: stateHash(before) !== stateHash(after) };
    if (this.pending.size >= 30) this.pending.clear();
    this.pending.set(key, { id, key, before, after, ownership: own, connectionId, public: result });
    return result;
  }
  async preview(profile: ClaudeGuiGatewayProfile): Promise<ClaudeGuiConfigPreview> {
    validate(profile);
    this.checkSchema();
    if (this.isPolicyManaged()) throw new Error('Claude 桌面由管理策略控制，本机配置会被忽略；请在官方配置窗口核对。');
    const before = this.readAll(), own = this.ownership();
    before.forEach(file => this.parse(file));
    if (own.lastAppliedHash) this.requireUnchanged(own.lastAppliedHash);
    if (before[0].existed && !own.baselineId) throw new Error('管理器专用 Claude 桌面配置 ID 已有外部文件；未覆盖，请核对配置来源。');
    const meta = this.meta(before[2]);
    if (!meta.entries.some((entry: any) => entry.id === CLAUDE_GUI_MANAGED_ID)) meta.entries.push({ id: CLAUDE_GUI_MANAGED_ID, name: '续航台本机 API' });
    meta.appliedId = CLAUDE_GUI_MANAGED_ID;
    delete meta.hybridPointer; // Mirrors the installed app's LWn entry selection.
    const after: FileState[] = [
      { role: 'profile', existed: true, raw: encode(buildClaudeGuiGatewayConfig(profile)) },
      { role: 'mode', existed: true, raw: encode({ ...this.parse(before[1]), deploymentMode: '3p' }) },
      { role: 'meta', existed: true, raw: encode(meta) },
    ];
    return this.remember(`api:${sha(JSON.stringify(profile))}`, before, after, own, 'api', [
      '本次配置官方 Claude 桌面 Chat、Cowork、Code 的用户级第三方推理；独立于 Claude Code CLI。',
      '供应商 API Key 留在续航台加密库；桌面配置只保存本机网关令牌，续航台需保持运行。',
      '仅修改管理器自己的配置条目、当前条目索引与 deploymentMode；其他配置条目、登录凭据、浏览器缓存不会修改。',
      '三处原文件将完整加密备份；完全退出 Claude 桌面后应用，重启并选择继续使用第三方推理。',
      '已按本机 Claude 2.31226.1 安装源码核实配置格式与模型规则；升级后应重新核对官方版本与诊断结果。',
      '配置完成表示文件已设置；实际计费来源须在桌面发起任务后核对续航台记录。此操作不会调用付费 API。',
    ], profile.connectionId);
  }
  private snapshotPath(id: string): string {
    if (!/^claude-gui-[a-f0-9-]{36}$/.test(id)) throw new Error('Claude 桌面备份 ID 无效。');
    return path.join(this.backupDir, `${id}.encrypted.json`);
  }
  private createSnapshot(before: FileState[], after: FileState[], own: Ownership, label: string): Snapshot {
    if (!this.cipher.isEncryptionAvailable()) throw new Error('本机加密存储不可用；无法安全备份，因此未修改 Claude 桌面配置。');
    const snapshot: Snapshot = { id: `claude-gui-${randomUUID()}`, engine: 'claude', surface: 'desktop', configLibraryPath: this.configLibraryPath, createdAt: new Date().toISOString(), label, encrypted: this.cipher.encryptString(JSON.stringify(before)).toString('base64'), expectedHash: stateHash(after), previousOwnership: own };
    this.writeAtomic(this.snapshotPath(snapshot.id), encode(snapshot));
    return snapshot;
  }
  private readSnapshot(id: string): Snapshot {
    const filename = this.snapshotPath(id);
    this.safeParents(filename);
    if (!fs.existsSync(filename)) throw new Error('Claude 桌面加密备份不存在。');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES * 5) throw new Error('Claude 桌面加密备份文件不安全。');
    const snapshot = object(fs.readFileSync(filename, 'utf8'), 'Claude 桌面备份') as Snapshot;
    if (snapshot.id !== id || snapshot.surface !== 'desktop' || snapshot.engine !== 'claude' || snapshot.configLibraryPath !== this.configLibraryPath || typeof snapshot.encrypted !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.expectedHash)) throw new Error('备份与当前 Claude 桌面配置不匹配。');
    return snapshot;
  }
  private decrypt(snapshot: Snapshot): FileState[] {
    if (!this.cipher.isEncryptionAvailable()) throw new Error('本机加密存储不可用，无法恢复 Claude 桌面配置。');
    let files: FileState[];
    try { files = JSON.parse(this.cipher.decryptString(Buffer.from(snapshot.encrypted, 'base64'))); } catch { throw new Error('备份仅能在原用户/机器解密；未修改 Claude 桌面配置。'); }
    if (!Array.isArray(files) || files.length !== 3 || files.some((file, index) => file.role !== (['profile', 'mode', 'meta'] as const)[index] || typeof file.existed !== 'boolean' || typeof file.raw !== 'string' || Buffer.byteLength(file.raw) > MAX_FILE_BYTES || !file.existed && file.raw !== '')) throw new Error('Claude 桌面备份内容格式无效；未修改文件。');
    files.forEach(file => this.parse(file));
    this.meta(files[2]);
    return files;
  }
  private put(file: FileState, expected?: FileState): void {
    const check = (): void => {
      if (expected && fileHash(this.read(file.role)) !== fileHash(expected)) throw new Error('Claude 桌面文件在写入前被外部修改。');
    };
    if (file.existed) this.writeAtomic(this.filename(file.role), file.raw, check);
    else { check(); if (fs.existsSync(this.filename(file.role))) fs.unlinkSync(this.filename(file.role)); }
  }
  private commit(before: FileState[], after: FileState[]): void {
    this.requireUnchanged(stateHash(before));
    const completed: number[] = [];
    try {
      for (let index = 0; index < before.length; index++) {
        if (fileHash(before[index]) === fileHash(after[index])) continue;
        if (fileHash(this.read(before[index].role)) !== fileHash(before[index])) throw new Error('Claude 桌面文件在写入前被外部修改。');
        this.put(after[index], before[index]);
        completed.push(index);
      }
      this.requireUnchanged(stateHash(after));
    } catch (error) {
      // Roll back only bytes we can prove are still ours; preserve any external edit.
      for (const index of completed.reverse()) {
        if (fileHash(this.read(after[index].role)) === fileHash(after[index])) this.put(before[index], after[index]);
      }
      throw error;
    }
  }
  private async mutate<T>(work: () => T): Promise<T> {
    if (this.mutation) throw new Error('另一个 Claude 桌面配置操作正在进行。');
    this.mutation = true;
    try { this.checkWritable(); return work(); } finally { this.mutation = false; }
  }
  async apply(profile: ClaudeGuiGatewayProfile): Promise<ClaudeGuiConfigResult> {
    validate(profile);
    const key = `api:${sha(JSON.stringify(profile))}`, plan = this.pending.get(key);
    if (!plan) throw new Error('请先预览此 Claude 桌面配置，再应用。');
    return this.mutate(() => {
      this.requireUnchanged(stateHash(plan.before));
      this.pending.delete(key);
      if (!plan.public.changed) return { ok: true, restartRequired: true, activationState: 'configured', message: 'Claude 桌面本机配置已经一致；重启官方桌面后核对实际来源。' };
      const backup = this.createSnapshot(plan.before, plan.after, plan.ownership, '接入 Claude 桌面本机 API 前');
      this.commit(plan.before, plan.after);
      this.saveOwnership({ configLibraryPath: this.configLibraryPath, baselineId: plan.ownership.baselineId || backup.id, latestBackupId: backup.id, lastAppliedHash: stateHash(plan.after), connectionId: profile.connectionId });
      return { ok: true, restartRequired: true, backupId: backup.id, activationState: 'configured', message: '已设置官方 Claude 桌面的本机 API 配置并加密备份原文件。重启 Claude 桌面并继续使用第三方推理；实际调用通过续航台费用记录核对。' };
    });
  }
  private subscriptionPlan(): { before: FileState[]; after: FileState[]; own: Ownership; warnings: string[] } {
    const before = this.readAll(), own = this.ownership();
    before.forEach(file => this.parse(file));
    this.meta(before[2]);
    if (!own.baselineId) return { before, after: before, own, warnings: ['没有续航台桌面接管记录，不删除已有配置。请在官方桌面登录界面选择 Anthropic 登录；会员状态由官方应用确认。'] };
    if (!own.lastAppliedHash) throw new Error('缺少 Claude 桌面接管哈希，无法安全恢复原配置。');
    this.requireUnchanged(own.lastAppliedHash);
    const after = this.decrypt(this.readSnapshot(own.baselineId));
    return { before, after, own, warnings: ['将精确恢复首次接管前的三处文件；原配置可能属于其他供应商，恢复原配置不代表已经确认会员计费。', '未读取或修改会员登录凭据；恢复后需重启 Claude 桌面并在官方应用确认登录方式。'] };
  }
  async previewSubscription(): Promise<ClaudeGuiConfigPreview> {
    this.checkSchema();
    const plan = this.subscriptionPlan();
    return this.remember('subscription', plan.before, plan.after, plan.own, 'subscription', plan.warnings);
  }
  async applySubscription(): Promise<ClaudeGuiConfigResult> {
    const plan = this.pending.get('subscription');
    if (!plan) throw new Error('请先预览恢复 Claude 桌面原配置，再应用。');
    return this.mutate(() => {
      this.requireUnchanged(stateHash(plan.before));
      this.pending.delete('subscription');
      if (!plan.public.changed) return { ok: true, restartRequired: false, activationState: this.getStatus().activationState, message: plan.public.warnings[0] };
      const backup = this.createSnapshot(plan.before, plan.after, plan.ownership, '恢复 Claude 桌面首次接管前配置前');
      this.commit(plan.before, plan.after);
      this.saveOwnership({ configLibraryPath: this.configLibraryPath });
      return { ok: true, restartRequired: true, backupId: backup.id, activationState: this.getStatus().activationState, message: '已恢复 Claude 桌面首次接管前的原文件。重启后在官方桌面确认登录方式与计费来源。' };
    });
  }
  async restore(id?: string): Promise<ClaudeGuiConfigResult> {
    return this.mutate(() => {
      const own = this.ownership(), target = id || own.latestBackupId;
      if (!target) throw new Error('没有可恢复的 Claude 桌面配置备份。');
      const snapshot = this.readSnapshot(target), before = this.readAll();
      this.requireUnchanged(snapshot.expectedHash);
      const after = this.decrypt(snapshot);
      this.commit(before, after);
      const previous = snapshot.previousOwnership;
      this.saveOwnership(previous?.configLibraryPath === this.configLibraryPath ? previous : { configLibraryPath: this.configLibraryPath });
      return { ok: true, restartRequired: true, backupId: snapshot.id, activationState: this.getStatus().activationState, message: '已恢复对应 Claude 桌面加密备份。重启官方桌面后核对计费来源。' };
    });
  }
  listBackups(): ConfigBackupInfo[] {
    if (!fs.existsSync(this.backupDir)) return [];
    this.safeParents(this.ownershipPath);
    let currentHash = '';
    try { currentHash = this.fingerprint(); } catch { /* Preserve backup visibility when the config is invalid. */ }
    const result: ConfigBackupInfo[] = [];
    const schemaSupported = this.isSchemaSupported();
    for (const filename of fs.readdirSync(this.backupDir)) {
      if (!/^claude-gui-[a-f0-9-]{36}\.encrypted\.json$/.test(filename)) continue;
      try {
        const snapshot = this.readSnapshot(filename.replace(/\.encrypted\.json$/, ''));
        let canRestore = schemaSupported && currentHash === snapshot.expectedHash;
        if (canRestore) { try { this.decrypt(snapshot); } catch { canRestore = false; } }
        result.push({ id: snapshot.id, engine: 'claude', configPath: this.configPath, createdAt: snapshot.createdAt, label: snapshot.label, canRestore });
      } catch { /* Ignore malformed backups without exposing their payload. */ }
    }
    return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  getStatus(profile?: ClaudeGuiGatewayProfile): Omit<ClaudeGuiStatus, 'executablePath' | 'running' | 'backups'> {
    type Status = Omit<ClaudeGuiStatus, 'executablePath' | 'running' | 'backups'>;
    const base = { configPath: this.configPath, configExists: fs.existsSync(this.configPath), activationKind: 'auto' as 'auto' | 'manual-import' };
    let schemaSupported = false;
    const finish = (value: Status): Status => schemaSupported ? value : { ...value, activationKind: 'manual-import', activationState: 'unknown', message: '此 Claude 桌面版本尚未核实，当前只读取公开配置元数据。请使用官方 Developer → Configure Third-Party Inference 窗口；自动写入已停止。' };
    try {
      schemaSupported = this.isSchemaSupported();
      if (!schemaSupported) base.activationKind = 'manual-import';
      if (this.isPolicyManaged()) return finish({ ...base, mode: 'unknown', activationState: 'external', policyManaged: true, message: 'Claude 桌面有管理策略，本机第三方配置可能被覆盖。' });
      const files = this.readAll(), meta = this.meta(files[2]), mode = this.parse(files[1]), own = this.ownership();
      if (meta.appliedId !== CLAUDE_GUI_MANAGED_ID) return finish({ ...base, mode: meta.appliedId ? 'unknown' : 'subscription', activationState: meta.appliedId ? 'external' : 'unconfigured', message: meta.appliedId ? '当前桌面条目由其他配置管理；未修改其内容。' : '未接入续航台桌面网关；会员登录状态请在官方 Claude 桌面确认。' });
      const configured = this.parse(files[0]);
      if (claudeGuiModelIssue(configured.inferenceModels?.[0]?.name)) return finish({ ...base, mode: 'unknown', activationState: 'unknown', message: '桌面条目模型不符合已核实的 Claude 2.31226.1 模型规则；请在官方应用核对，配置未修改。' });
      if (configured.inferenceProvider !== 'gateway' || !own.lastAppliedHash || own.lastAppliedHash !== stateHash(files)) return finish({ ...base, mode: 'unknown', activationState: 'unknown', message: '桌面配置与续航台写入记录不一致，请重新预览并核对。' });
      if (profile && (configured.inferenceGatewayBaseUrl !== profile.gatewayBaseUrl || configured.inferenceGatewayApiKey !== profile.gatewayToken || configured.inferenceModels?.[0]?.name !== profile.model)) return finish({ ...base, mode: 'unknown', activationState: 'unknown', message: '桌面本机网关令牌、地址或模型已更换，请重新应用桌面配置。' });
      return finish({ ...base, mode: mode.deploymentMode === '1p' ? 'subscription' : 'api', activationState: mode.deploymentMode === '1p' ? 'prepared' : 'configured', activeConnectionId: own.connectionId, model: configured.inferenceModels?.[0]?.name, gatewayBaseUrl: configured.inferenceGatewayBaseUrl, message: mode.deploymentMode === '1p' ? '桌面配置已准备，当前选择标准 Claude 登录；实际登录状态请在官方应用确认。' : 'Claude 桌面本机网关配置已设置，重启后由实际调用记录确认接入。' });
    } catch { return finish({ ...base, mode: 'unknown', activationState: 'unknown', message: '无法安全读取桌面配置或管理策略；未修改原文件。' }); }
  }
}
