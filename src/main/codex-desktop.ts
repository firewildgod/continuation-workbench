import { safeStorage } from 'electron';
import * as TOML from '@iarna/toml';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { ConfigBackupInfo, ConfigPreview, ConfigResult } from '../shared/types';

const PROVIDER = 'continuation_workbench';
const CATALOG_REVISION = 'capabilities-2026-10-11';
const MANAGED_KEYS = ['model', 'model_provider', 'model_catalog_json', 'web_search'] as const;
type ManagedKey = typeof MANAGED_KEYS[number];
type Document = Record<string, any>;

export interface ConfigCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface CodexDesktopOptions {
  configPath?: string;
  backupDir: string;
  catalogDir: string;
  cipher?: ConfigCipher;
}
export interface GatewayConfigInput {
  baseUrl: string;
  relayToken: string;
  model: string;
  name?: string;
  catalogKind?: 'deepseek' | 'generic';
}
export interface DesktopConfigPreview extends ConfigPreview {
  previewId: string;
  currentModel?: string;
  currentProvider?: string;
  targetModel?: string;
  targetProvider?: string;
  changedKeys: string[];
  restartRequired: true;
  label: string;
}
interface PendingPreview {
  public: DesktopConfigPreview;
  before: string;
  after: string;
  existed: boolean;
  catalog?: { path: string; content: string };
}
interface BackupMetadata extends ConfigBackupInfo {
  existed: boolean;
  beforeHash: string;
  appliedHash: string;
  payloadFile: string;
}
interface Baseline {
  configPath: string;
  createdAt: string;
  existed: boolean;
  encrypted: string;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const samePath = (left: string, right: string): boolean => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

function parse(content: string): Document {
  try { return TOML.parse(content) as Document; }
  catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : '无法解析';
    throw new Error(`现有 Codex 配置不是有效 TOML，未修改文件：${detail}`);
  }
}
function canonical(value: any): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function publicToml(content: string): string {
  const secrets = new Set<string>();
  function collect(value: unknown, sensitive = false): void {
    if (typeof value === 'string') { if (sensitive && value) secrets.add(value); return; }
    if (Array.isArray(value)) { for (const item of value) collect(item, sensitive); return; }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        collect(child, sensitive || /token|password|secret|api[_-]?key|bearer|authorization|http_headers|^auth$/i.test(key));
      }
    }
  }
  collect(parse(content));
  let result = content;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    for (const literal of [secret, secret.replace(/\n/g, '\r\n'), JSON.stringify(secret).slice(1, -1)]) {
      if (literal) result = result.split(literal).join('[已隐藏]');
    }
  }
  return result.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[已隐藏]');
}

/** Edit only owned fields, then prove all other parsed TOML values are unchanged. */
function patchConfig(source: string, fields: Partial<Record<ManagedKey, unknown>>, provider?: Document): string {
  const before = parse(source);
  const expected = structuredClone(before);
  for (const key of MANAGED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    if (fields[key] === undefined) delete expected[key]; else expected[key] = fields[key];
  }
  if (provider) {
    expected.model_providers ??= {};
    if (typeof expected.model_providers !== 'object' || Array.isArray(expected.model_providers)) {
      throw new Error('现有 model_providers 格式不支持安全编辑，未修改文件。');
    }
    expected.model_providers[PROVIDER] = provider;
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const retained: string[] = [];
  let topLevel = true;
  let ownedBlock = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+)\]\]?\s*(?:#.*)?$/);
    if (header) {
      topLevel = false;
      const normalized = header[1].replace(/["'\s]/g, '');
      ownedBlock = Boolean(provider && (normalized === `model_providers.${PROVIDER}`
        || normalized.startsWith(`model_providers.${PROVIDER}.`)));
    }
    if (ownedBlock) continue;
    const key = topLevel ? line.match(/^\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9_-]+))\s*=/) : null;
    if (key && Object.prototype.hasOwnProperty.call(fields, key[1] || key[2] || key[3])) continue;
    retained.push(line);
  }
  const prefix = Object.entries(fields).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
  const chunks = [prefix.join(newline), retained.join(newline).trimEnd()];
  if (provider) chunks.push(TOML.stringify({ model_providers: { [PROVIDER]: provider } } as any).trimEnd());
  const result = `${chunks.filter(Boolean).join(`${newline}${newline}`)}${newline}`;
  if (canonical(parse(result)) !== canonical(expected)) {
    throw new Error('配置包含无法安全局部编辑的 TOML 写法，未修改文件。请使用配置预览检查现有格式。');
  }
  return result;
}

function modelCapabilities(model: string, kind: 'deepseek' | 'generic') {
  // Exact IDs only. Model modality never follows a provider-wide assumption.
  // https://help.aliyun.com/zh/model-studio/qwen3-8-flash
  // https://help.aliyun.com/zh/model-studio/qwen3-8-max
  // https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses
  const qwen = ['qwen3.8-flash', 'qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-max-2026-09-02'].includes(model);
  const directDeepseek = kind === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(model);
  const hostedFlash = kind === 'generic' && model === 'deepseek-v4.1-flash';
  const hostedPro = kind === 'generic' && ['deepseek-v4-pro', 'deepseek-v4-pro-0813'].includes(model);
  const image = qwen || hostedFlash || directDeepseek && model === 'deepseek-flash';
  const known = qwen || directDeepseek || hostedFlash || hostedPro;
  const efforts = qwen ? ['none', 'low', 'medium', 'xhigh']
    : directDeepseek || hostedFlash || hostedPro && model === 'deepseek-v4-pro-0813' ? ['none', 'low', 'high', 'max']
    : hostedPro ? ['none', 'high', 'max'] : [];
  return { known, image, directDeepseek,
    // Bailian's Responses input boundary is about 80% of its model window.
    contextWindow: directDeepseek ? 1_048_576 : known ? 1_000_000 : 32_768,
    effectivePercent: directDeepseek || !known ? 95 : 80,
    defaultEffort: qwen ? 'xhigh' : directDeepseek || hostedFlash || hostedPro ? 'high' : null,
    efforts,
  };
}
function modelCatalog(model: string, kind: 'deepseek' | 'generic'): string {
  const capabilities = modelCapabilities(model, kind), deepseek = capabilities.directDeepseek;
  return JSON.stringify({ models: [{
    slug: model, display_name: model,
    description: 'Local API gateway model',
    base_instructions: 'You are a local coding assistant. Follow the project instructions, inspect relevant files before editing, preserve existing changes, use available tools, verify the result, and report remaining issues. Never repeat a command whose outcome is unknown.',
    prefer_websockets: false, support_verbosity: deepseek, default_verbosity: 'low',
    apply_patch_tool_type: deepseek ? 'freeform' : null,
    web_search_tool_type: 'text', input_modalities: capabilities.image ? ['text', 'image'] : ['text'],
    // Both supplier Codex catalog guides explicitly advertise original image detail.
    // https://help.aliyun.com/zh/model-studio/codex
    // https://api-docs.deepseek.com/quick_start/agent_integrations/codex/
    supports_image_detail_original: capabilities.image, truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: deepseek, experimental_supported_tools: [], tool_mode: null,
    multi_agent_version: 'v2', use_responses_lite: false, include_skills_usage_instructions: false,
    auto_review_model_override: null, context_window: capabilities.contextWindow,
    max_context_window: capabilities.contextWindow, effective_context_window_percent: capabilities.effectivePercent,
    auto_compact_token_limit: null, comp_hash: '3000', reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none', default_reasoning_level: capabilities.defaultEffort,
    supported_reasoning_levels: capabilities.efforts.map(effort => ({ effort, description: effort })),
    shell_type: 'shell_command', visibility: 'list', minimal_client_version: '0.144.0',
    supported_in_api: true, priority: 0, availability_nux: null, upgrade: null,
  }] }, null, 2);
}

/** Manages the official desktop config, never its auth.json, processes or OAuth tokens. */
export class CodexDesktopAdapter {
  readonly configPath: string;
  private readonly backupDir: string;
  private readonly catalogDir: string;
  private readonly cipher: ConfigCipher;
  private previews = new Map<string, PendingPreview>();
  private mutation?: Promise<unknown>;

  constructor(options: CodexDesktopOptions) {
    this.configPath = resolve(options.configPath || join(homedir(), '.codex', 'config.toml'));
    this.backupDir = resolve(options.backupDir);
    this.catalogDir = resolve(options.catalogDir);
    this.cipher = options.cipher || safeStorage;
  }

  private async readCurrent(): Promise<{ content: string; existed: boolean }> {
    const file = await lstat(this.configPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!file) return { content: '', existed: false };
    if (file.isSymbolicLink() || !file.isFile()) throw new Error('配置路径不是普通文件，已停止自动编辑。');
    return { content: await readFile(this.configPath, 'utf8'), existed: true };
  }

  private requireCipher(): void {
    if (!this.cipher?.isEncryptionAvailable()) throw new Error('系统加密不可用，无法安全备份配置；未修改 Codex 文件。');
  }
  private async atomicWrite(path: string, content: string | Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async previewGateway(input: GatewayConfigInput): Promise<DesktopConfigPreview> {
    const url = new URL(input.baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) {
      throw new Error('桌面接入地址必须是此管理器的本机 HTTP 网关。');
    }
    if (!input.relayToken || /[\r\n\0]/.test(input.relayToken)) throw new Error('本机网关凭据格式无效。');
    if (!input.model.trim() || /[\r\n\0]/.test(input.model)) throw new Error('模型名称无效。');
    const current = await this.readCurrent();
    // A versioned path ensures reapplying an existing route writes revised model
    // metadata even when model/provider otherwise match the previous configuration.
    const modelHash = hash(`${CATALOG_REVISION}\n${input.model}\n${input.catalogKind || 'generic'}`).slice(0, 16);
    const catalog = { path: join(this.catalogDir, `codex-${modelHash}.json`),
      content: modelCatalog(input.model, input.catalogKind || 'generic') };
    const provider = {
      name: input.name || '续航台本机 API 网关', base_url: url.toString().replace(/\/$/, ''),
      wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
      http_headers: { Authorization: `Bearer ${input.relayToken}` },
    };
    const after = patchConfig(current.content, {
      model: input.model, model_provider: PROVIDER, model_catalog_json: catalog.path, web_search: 'disabled',
    }, provider);
    return this.remember(current, after, 'api', '接入本机 API 网关', catalog,
      ['官方桌面需要由你退出后重新启动，已有运行进程不会立即加载新的配置。',
        '网关必须保持运行；配置中的凭据只用于本机网关，厂商 API Key 保存在系统加密存储中。',
        ...(modelCapabilities(input.model, input.catalogKind || 'generic').known
          ? ['已按精确模型 ID 写入厂商声明的输入与上下文能力；完整工具调用仍需在官方应用验收。']
          : ['该模型 ID 的能力尚未核实，当前采用文本与 32K 上下文配置；请按厂商文档确认后再使用图片。'])]);
  }

  async previewSubscription(): Promise<DesktopConfigPreview> {
    const current = await this.readCurrent();
    const baseline = await this.readBaseline();
    const fields: Partial<Record<ManagedKey, unknown>> = {};
    let label = '恢复 OpenAI 默认配置';
    if (baseline) {
      const original = parse(this.cipher.decryptString(Buffer.from(baseline.encrypted, 'base64')));
      for (const key of MANAGED_KEYS) fields[key] = original[key];
      label = '恢复首次接管前的原配置';
    } else {
      for (const key of MANAGED_KEYS) fields[key] = undefined;
      fields.model_provider = 'openai';
    }
    const after = patchConfig(current.content, fields);
    return this.remember(current, after, 'subscription', label, undefined,
      ['将恢复原来的模型与供应商设置；账号登录方式和剩余额度由官方桌面确认。',
        '退出并重新启动官方桌面后配置才会生效。']);
  }

  private remember(current: { content: string; existed: boolean }, after: string,
    mode: 'api' | 'subscription', label: string, catalog: PendingPreview['catalog'], warnings: string[]): DesktopConfigPreview {
    const beforeParsed = parse(current.content);
    const afterParsed = parse(after);
    const preview: DesktopConfigPreview = {
      previewId: randomUUID(), engine: 'codex', mode, configPath: this.configPath,
      before: publicToml(current.content), after: publicToml(after), warnings,
      changed: current.content !== after, currentModel: beforeParsed.model,
      currentProvider: beforeParsed.model_provider, targetModel: afterParsed.model,
      targetProvider: afterParsed.model_provider, changedKeys: [...MANAGED_KEYS], restartRequired: true, label,
    };
    // Bound transient memory and keep raw configuration out of IPC/public previews.
    if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.previewId, { public: preview, before: current.content, after, existed: current.existed, catalog });
    return { ...preview, warnings: [...warnings] };
  }

  private async readBaseline(): Promise<Baseline | undefined> {
    const filename = join(this.backupDir, 'baseline.json');
    let text: string;
    try { text = await readFile(filename, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    this.requireCipher();
    const baseline = JSON.parse(text) as Baseline;
    if (!baseline || !samePath(baseline.configPath, this.configPath) || typeof baseline.encrypted !== 'string') {
      throw new Error('原配置备份属于另一台电脑或路径，已停止自动恢复。');
    }
    return baseline;
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mutation) throw new Error('正在更新配置，请等待当前操作完成。');
    const mutation = operation();
    this.mutation = mutation;
    try { return await mutation; } finally { this.mutation = undefined; }
  }

  async apply(previewId: string): Promise<ConfigResult & { configPath: string; backupPath?: string; catalogPath?: string }> {
    return this.serialized(async () => {
      const pending = this.previews.get(previewId);
      if (!pending) throw new Error('配置预览已失效，请重新预览。');
      const current = await this.readCurrent();
      if (current.existed !== pending.existed || hash(current.content) !== hash(pending.before)) {
        throw new Error('Codex 配置在预览后发生了变化，未覆盖；请重新预览。');
      }
      if (!pending.public.changed) return { ok: true, message: '配置已符合当前选择。', restartRequired: false, configPath: this.configPath };
      this.requireCipher();
      await mkdir(this.backupDir, { recursive: true });
      const baseline = await this.readBaseline();
      if (!baseline) {
        const original: Baseline = { configPath: this.configPath, createdAt: new Date().toISOString(),
          existed: current.existed, encrypted: this.cipher.encryptString(current.content).toString('base64') };
        await this.atomicWrite(join(this.backupDir, 'baseline.json'), JSON.stringify(original, null, 2));
      }
      const id = randomUUID();
      const payloadFile = `${id}.enc`;
      const backupPath = join(this.backupDir, payloadFile);
      const backup: BackupMetadata = {
        id, engine: 'codex', configPath: this.configPath, createdAt: new Date().toISOString(),
        label: pending.public.label, canRestore: true, existed: current.existed,
        beforeHash: hash(current.content), appliedHash: hash(pending.after), payloadFile,
      };
      await this.atomicWrite(backupPath, this.cipher.encryptString(current.content));
      await this.atomicWrite(join(this.backupDir, `${id}.json`), JSON.stringify(backup, null, 2));
      if (pending.catalog) await this.atomicWrite(pending.catalog.path, pending.catalog.content);
      // Check once more after writing backup/catalog, before replacing the live file.
      const latest = await this.readCurrent();
      if (latest.existed !== current.existed || hash(latest.content) !== hash(current.content)) {
        throw new Error('备份期间配置发生了变化，未覆盖；请重新预览。');
      }
      await this.atomicWrite(this.configPath, pending.after);
      this.previews.delete(previewId);
      return { ok: true, message: `${pending.public.label}已保存，并已加密备份原配置。请退出并重新启动官方 Codex。`,
        restartRequired: true, backupId: id, configPath: this.configPath, backupPath,
        ...(pending.catalog ? { catalogPath: pending.catalog.path } : {}) };
    });
  }

  async listBackups(): Promise<ConfigBackupInfo[]> {
    const files = await readdir(this.backupDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    const current = await this.readCurrent();
    const backups: ConfigBackupInfo[] = [];
    for (const file of files.filter(name => /^[a-f0-9-]{36}\.json$/i.test(name))) {
      try {
        const value = JSON.parse(await readFile(join(this.backupDir, file), 'utf8')) as BackupMetadata;
        if (!this.validBackup(value) || file !== `${value.id}.json`) continue;
        let decryptable = false;
        if (this.cipher?.isEncryptionAvailable()) {
          try { this.cipher.decryptString(await readFile(join(this.backupDir, value.payloadFile))); decryptable = true; }
          catch { /* Backups encrypted for another Windows account cannot be restored. */ }
        }
        backups.push({ id: value.id, engine: 'codex', configPath: value.configPath,
          createdAt: value.createdAt, label: value.label,
          canRestore: samePath(value.configPath, this.configPath) && decryptable && hash(current.content) === value.appliedHash });
      } catch { /* Ignore incomplete metadata from a failed or interrupted backup. */ }
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private validBackup(value: BackupMetadata): boolean {
    return Boolean(value && /^[a-f0-9-]{36}$/i.test(value.id) && value.payloadFile === `${value.id}.enc`
      && value.engine === 'codex' && typeof value.configPath === 'string' && typeof value.existed === 'boolean'
      && /^[a-f0-9]{64}$/i.test(value.beforeHash) && /^[a-f0-9]{64}$/i.test(value.appliedHash)
      && typeof value.createdAt === 'string' && typeof value.label === 'string');
  }

  async rollback(backupId: string): Promise<ConfigResult & { configPath: string }> {
    return this.serialized(async () => {
      if (!/^[a-f0-9-]{36}$/i.test(backupId)) throw new Error('备份编号无效。');
      this.requireCipher();
      const metadata = JSON.parse(await readFile(join(this.backupDir, `${backupId}.json`), 'utf8')) as BackupMetadata;
      if (!this.validBackup(metadata) || metadata.id !== backupId || !samePath(metadata.configPath, this.configPath)) {
        throw new Error('备份不是当前 Codex 配置的有效备份。');
      }
      const current = await this.readCurrent();
      if (hash(current.content) !== metadata.appliedHash) {
        throw new Error('应用后配置已被再次修改，为保留这些修改，已停止自动回滚。');
      }
      const original = this.cipher.decryptString(await readFile(join(this.backupDir, metadata.payloadFile)));
      if (hash(original) !== metadata.beforeHash) throw new Error('备份校验失败，未修改配置。');
      parse(original);
      const latest = await this.readCurrent();
      if (latest.existed !== current.existed || hash(latest.content) !== hash(current.content)) {
        throw new Error('回滚期间配置发生变化，未覆盖；请重新检查。');
      }
      if (metadata.existed) await this.atomicWrite(this.configPath, original);
      else await rm(this.configPath, { force: true });
      return { ok: true, configPath: this.configPath,
        message: '已恢复选择的配置备份。请退出并重新启动官方 Codex。', restartRequired: true };
    });
  }
}
