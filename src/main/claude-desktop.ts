import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { ConfigBackupInfo, ConfigPreview, ConfigResult } from '../shared/types';

export interface ClaudeGatewayProfile {
  connectionId: string; gatewayBaseUrl: string; gatewayToken: string; model: string;
}
type JsonObject = Record<string, unknown>;
interface Snapshot {
  id: string; engine: 'claude'; configPath: string; createdAt: string;
  label: string; existed: boolean; encrypted: string; expectedHash: string; previousOwnership?: Ownership;
}
interface Ownership {
  configPath: string; baselineId?: string; latestBackupId?: string;
  lastAppliedHash?: string; gatewayBaseUrl?: string;
}
const MODEL_SLOTS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
const ROUTE_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', ...MODEL_SLOTS];

function digest(value: string, existed = true): string { return createHash('sha256').update(existed ? value : '[file missing]').digest('hex'); }
function parseSettings(raw: string): JsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new Error('Claude settings.json 不是有效 JSON；未作修改，请先在原工具修复。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Claude settings.json 必须是 JSON 对象；未作修改。');
  const settings = parsed as JsonObject;
  if (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env))) throw new Error('Claude settings.json 的 env 格式无效；未作修改。');
  return settings;
}
function readSettings(filename: string): { existed: boolean; raw: string; value: JsonObject; hash: string } {
  if (!fs.existsSync(filename)) return { existed: false, raw: '', value: {}, hash: digest('', false) };
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Claude 配置需为不超过 2 MiB 的普通文件；未作修改。');
  const raw = fs.readFileSync(filename, 'utf8');
  return { existed: true, raw, value: parseSettings(raw), hash: digest(raw) };
}
function writeAtomic(filename: string, contents: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, contents, { mode: 0o600 }); fs.renameSync(temp, filename); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function encodeJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
/** Preview never exposes existing API keys, OAuth variables or custom headers. */
export function redactClaudeSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactClaudeSettings);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[已隐藏]') : value;
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, entry]) => [key, /key|token|secret|password|authorization|credential|cookie|headers/i.test(key) ? '[已隐藏]' : redactClaudeSettings(entry)]));
}
function validateGateway(profile: ClaudeGatewayProfile): void {
  let url: URL;
  try { url = new URL(profile.gatewayBaseUrl); } catch { throw new Error('本机网关地址无效。'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/claude' || url.username || url.password || url.search || url.hash) throw new Error('Claude 管理器配置只允许 http://127.0.0.1:端口/claude 本机网关。');
  if (!profile.model.trim() || /[\r\n\0]/.test(profile.model) || !profile.gatewayToken || /[\r\n\0]/.test(profile.gatewayToken)) throw new Error('本机网关模型或令牌无效。');
}
function patchGateway(original: JsonObject, profile: ClaudeGatewayProfile): JsonObject {
  validateGateway(profile);
  const result = structuredClone(original);
  const env = { ...((result.env as JsonObject | undefined) || {}) };
  env.ANTHROPIC_BASE_URL = profile.gatewayBaseUrl;
  env.ANTHROPIC_AUTH_TOKEN = profile.gatewayToken;
  // Empty values override a conflicting parent-shell credential. Only the local
  // gateway token is written here; vendor secrets stay in the manager's vault.
  env.ANTHROPIC_API_KEY = '';
  // A saved custom Authorization/x-api-key header can override the local token.
  // Preserve it in the encrypted baseline, but clear it while we own routing.
  env.ANTHROPIC_CUSTOM_HEADERS = '';
  env.CLAUDE_CODE_OAUTH_TOKEN = '';
  for (const flag of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) env[flag] = '0';
  for (const modelSlot of MODEL_SLOTS) env[modelSlot] = profile.model;
  result.env = env;
  delete result.apiKeyHelper;
  return result;
}
function hasExternalApiSettings(settings: JsonObject): boolean {
  const env = (settings.env || {}) as JsonObject;
  return Boolean(settings.apiKeyHelper || env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN || ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(flag => env[flag] && env[flag] !== '0'));
}

export function buildClaudeVSCodeSettings(profile: ClaudeGatewayProfile): JsonObject {
  const env = patchGateway({}, profile).env as JsonObject;
  return { 'claudeCode.environmentVariables': Object.entries(env).map(([name, value]) => ({ name, value })) };
}

/** Claude Code CLI settings adapter. Claude Desktop uses separate 3P settings. */
export class ClaudeDesktopAdapter {
  readonly settingsPath: string;
  private backupDir: string;
  private ownershipPath: string;

  constructor(options: { backupDir: string; settingsPath?: string }) {
    this.settingsPath = path.resolve(options.settingsPath || path.join(os.homedir(), '.claude', 'settings.json'));
    if (!['settings.json', 'settings.local.json'].includes(path.basename(this.settingsPath).toLowerCase())) throw new Error('请选择 Claude 的 settings.json 或 settings.local.json；不能选择登录凭据文件。');
    this.backupDir = path.resolve(options.backupDir);
    this.ownershipPath = path.join(this.backupDir, 'ownership.json');
  }
  private ownership(): Ownership {
    if (!fs.existsSync(this.ownershipPath)) return { configPath: this.settingsPath };
    try {
      const value = JSON.parse(fs.readFileSync(this.ownershipPath, 'utf8')) as Ownership;
      return value.configPath === this.settingsPath ? value : { configPath: this.settingsPath };
    } catch { throw new Error('Claude 配置归属记录损坏；保留文件，未改动原配置。'); }
  }
  private saveOwnership(value: Ownership): void { writeAtomic(this.ownershipPath, encodeJson(value)); }
  private snapshotPath(id: string): string {
    if (!/^claude-[A-Za-z0-9-]{1,80}$/.test(id)) throw new Error('备份 ID 无效。');
    return path.join(this.backupDir, `${id}.encrypted.json`);
  }
  private readSnapshot(id: string): Snapshot {
    let snapshot: Snapshot;
    try { snapshot = JSON.parse(fs.readFileSync(this.snapshotPath(id), 'utf8')) as Snapshot; }
    catch { throw new Error('Claude 加密备份不存在或格式损坏；未改动原配置。'); }
    if (snapshot.id !== id || snapshot.engine !== 'claude' || snapshot.configPath !== this.settingsPath || typeof snapshot.encrypted !== 'string') throw new Error('备份与当前 Claude 配置路径不匹配。');
    return snapshot;
  }
  private decrypt(snapshot: Snapshot): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('本机加密存储不可用，无法恢复配置。');
    try { return safeStorage.decryptString(Buffer.from(snapshot.encrypted, 'base64')); }
    catch { throw new Error('备份仅能在原 Windows 用户/机器解密；没有改动原配置。'); }
  }
  private createSnapshot(current: ReturnType<typeof readSettings>, expectedHash: string, label: string): Snapshot {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('本机加密存储不可用；无法安全备份旧配置，因此未作修改。');
    const snapshot: Snapshot = { id: `claude-${randomUUID()}`, engine: 'claude', configPath: this.settingsPath, createdAt: new Date().toISOString(), label, existed: current.existed, encrypted: safeStorage.encryptString(current.raw).toString('base64'), expectedHash, previousOwnership: this.ownership() };
    writeAtomic(this.snapshotPath(snapshot.id), encodeJson(snapshot));
    return snapshot;
  }
  private requireUnchanged(currentHash: string, expectedHash: string): void {
    if (currentHash !== expectedHash) throw new Error('原 Claude 配置在接管后被修改；为保留你的新设置，已停止写入。请核对配置后重新预览。');
  }
  async preview(profile: ClaudeGatewayProfile): Promise<ConfigPreview> {
    const current = readSettings(this.settingsPath);
    const after = patchGateway(current.value, profile);
    return {
      engine: 'claude', mode: 'api', configPath: this.settingsPath,
      before: current.existed ? encodeJson(redactClaudeSettings(current.value)) : '（配置文件尚不存在）', after: encodeJson(redactClaudeSettings(after)), changed: current.raw !== encodeJson(after),
      warnings: [
        '供应商密钥保留在本机加密库；Claude 配置仅写本机网关地址与本机令牌。管理器需保持运行。',
        '保留其他设置、hooks、MCP；原配置将整份加密备份，仅原 Windows 用户/机器能恢复。',
        '首次从会员切到 API 后请重新启动官方 Claude Code，并用 /status 核对；当前正在执行的任务不会热切换。',
        'VS Code 扩展需另在 claudeCode.environmentVariables 设置本机网关变量并完全重启；本次只自动修改 Claude Code 配置。',
        'Claude 桌面版的 Code 标签使用独立第三方推理配置，不读取此 settings.json；本次不会切换 Claude 桌面版。',
        '项目设置、启动参数或管理员策略可能覆盖用户配置；真实工具调用仍需在原工作台验收。',
      ],
    };
  }
  async apply(profile: ClaudeGatewayProfile): Promise<ConfigResult> {
    const current = readSettings(this.settingsPath);
    const own = this.ownership();
    if (own.baselineId && own.lastAppliedHash) this.requireUnchanged(current.hash, own.lastAppliedHash);
    const raw = encodeJson(patchGateway(current.value, profile));
    if (current.raw === raw) return { ok: true, restartRequired: false, message: 'Claude 本机网关配置已经一致，无需重复写入。' };
    const backup = this.createSnapshot(current, digest(raw), '接入本机 API 网关前');
    // Check again after encryption: a user's editor can change the file at any time.
    this.requireUnchanged(readSettings(this.settingsPath).hash, current.hash);
    writeAtomic(this.settingsPath, raw);
    this.saveOwnership({ configPath: this.settingsPath, baselineId: own.baselineId || backup.id, latestBackupId: backup.id, lastAppliedHash: digest(raw), gatewayBaseUrl: profile.gatewayBaseUrl });
    return { ok: true, restartRequired: true, backupId: backup.id, message: '已配置 Claude Code CLI 本机 API 网关并加密备份原设置。请在原终端重启并用 /status 确认；VS Code 扩展与 Claude 桌面版需分别配置。' };
  }
  private subscriptionPlan(): { current: ReturnType<typeof readSettings>; original: ReturnType<typeof readSettings>; own: Ownership; message: string; changed: boolean } {
    const current = readSettings(this.settingsPath);
    const own = this.ownership();
    if (own.baselineId) {
      const snapshot = this.readSnapshot(own.baselineId);
      const raw = this.decrypt(snapshot);
      const original = { existed: snapshot.existed, raw, value: snapshot.existed ? parseSettings(raw) : {}, hash: digest(raw, snapshot.existed) };
      const message = hasExternalApiSettings(original.value) ? '将恢复首次接管前的原配置。原配置包含其他 API 或认证设置，不能保证使用会员额度。' : '将恢复首次接管前的原配置；会员状态仍由官方 Claude Code 登录与 /status 确认。';
      return { current, original, own, message, changed: current.hash !== original.hash };
    }
    if (own.gatewayBaseUrl && own.lastAppliedHash === current.hash && ((current.value.env || {}) as JsonObject).ANTHROPIC_BASE_URL === own.gatewayBaseUrl) {
      const originalValue = structuredClone(current.value);
      const env = { ...((originalValue.env || {}) as JsonObject) };
      for (const key of ROUTE_KEYS) delete env[key];
      if (Object.keys(env).length) originalValue.env = env; else delete originalValue.env;
      const raw = encodeJson(originalValue);
      const original = { existed: true, raw, value: originalValue, hash: digest(raw) };
      return { current, original, own, message: hasExternalApiSettings(originalValue) ? '缺少首次接管备份，只能清理管理器已确认拥有的网关变量。仍存在其他认证设置，不能保证会员模式。' : '缺少首次接管备份，将仅清理管理器已确认拥有的网关变量。会员状态请在官方工具确认。', changed: raw !== current.raw };
    }
    // Without a manager ownership record, an arbitrary localhost endpoint may
    // belong to another tool. Preserve it rather than claiming it is ours.
    return { current, original: current, own, message: hasExternalApiSettings(current.value) ? '没有首次接管备份；检测到已有 API/认证配置，本次不会删除。请在原工具核对后切回会员，不能保证会员模式。' : '没有管理器接管记录，无需恢复。请在官方 Claude Code 登录并用 /status 确认会员模式。', changed: false };
  }
  async previewSubscription(): Promise<ConfigPreview> {
    const plan = this.subscriptionPlan();
    return { engine: 'claude', mode: 'subscription', configPath: this.settingsPath, before: plan.current.existed ? encodeJson(redactClaudeSettings(plan.current.value)) : '（配置文件尚不存在）', after: plan.original.existed ? encodeJson(redactClaudeSettings(plan.original.value)) : '（恢复原状：配置文件不存在）', warnings: [plan.message, '未触碰会员凭据文件；恢复后需重启原工具。VS Code 用户环境设置需要单独核对。'], changed: plan.changed };
  }
  async applySubscription(): Promise<ConfigResult> {
    const plan = this.subscriptionPlan();
    if (!plan.changed) return { ok: true, restartRequired: false, message: plan.message };
    if (!plan.own.lastAppliedHash) throw new Error('缺少管理器写入记录，无法安全恢复原配置。');
    this.requireUnchanged(plan.current.hash, plan.own.lastAppliedHash);
    const backup = this.createSnapshot(plan.current, plan.original.hash, '恢复首次接管前原配置前');
    this.requireUnchanged(readSettings(this.settingsPath).hash, plan.current.hash);
    if (plan.original.existed) writeAtomic(this.settingsPath, plan.original.raw);
    else if (fs.existsSync(this.settingsPath)) fs.unlinkSync(this.settingsPath);
    this.saveOwnership({ configPath: this.settingsPath });
    return { ok: true, restartRequired: true, backupId: backup.id, message: plan.message.replace('将恢复', '已恢复') };
  }
  async restore(id?: string): Promise<ConfigResult> {
    const own = this.ownership();
    const targetId = id || own.latestBackupId;
    if (!targetId) throw new Error('没有可恢复的 Claude 配置备份。');
    const snapshot = this.readSnapshot(targetId);
    const current = readSettings(this.settingsPath);
    this.requireUnchanged(current.hash, snapshot.expectedHash);
    const raw = this.decrypt(snapshot);
    if (snapshot.existed) parseSettings(raw);
    this.requireUnchanged(readSettings(this.settingsPath).hash, current.hash);
    if (snapshot.existed) writeAtomic(this.settingsPath, raw);
    else if (fs.existsSync(this.settingsPath)) fs.unlinkSync(this.settingsPath);
    const previous = snapshot.previousOwnership;
    this.saveOwnership(previous?.configPath === this.settingsPath ? { ...previous, lastAppliedHash: previous.baselineId ? digest(raw, snapshot.existed) : undefined } : { configPath: this.settingsPath });
    return { ok: true, restartRequired: true, backupId: snapshot.id, message: '已恢复对应加密备份。原备份可能包含其他 API 配置，请在官方工具用 /status 确认计费来源。' };
  }
  listBackups(): ConfigBackupInfo[] {
    if (!fs.existsSync(this.backupDir)) return [];
    let currentHash = '';
    try { currentHash = readSettings(this.settingsPath).hash; } catch { /* Invalid current JSON must not hide backup history. */ }
    const result: ConfigBackupInfo[] = [];
    for (const filename of fs.readdirSync(this.backupDir)) {
      if (!/^claude-[A-Za-z0-9-]+\.encrypted\.json$/.test(filename)) continue;
      try {
        const snapshot = this.readSnapshot(filename.replace(/\.encrypted\.json$/, ''));
        let canRestore = currentHash === snapshot.expectedHash;
        if (canRestore) { try { this.decrypt(snapshot); } catch { canRestore = false; } }
        result.push({ id: snapshot.id, engine: 'claude', configPath: snapshot.configPath, createdAt: snapshot.createdAt, label: snapshot.label, canRestore });
      } catch { /* Ignore malformed own backup files without exposing their contents. */ }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export const CLAUDE_MANAGED_ENV_KEYS = [...ROUTE_KEYS];
