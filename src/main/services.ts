import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeStorage } from 'electron';
import { normalizeUsage } from './usage';
import { getBuiltInPricing } from './pricing';
import type { Checkpoint, Connection, ConnectionInput, Project, Protocol, ProviderPreset, RuntimeDiagnostic, Settings, TestResult, UsagePricing } from '../shared/types';
import type { UsageCapture, OfficialPricingTarget, OfficialPricingResult, OfficialPricingRefreshReport } from '../shared/usage';

const execFileAsync = promisify(execFile);
const DEFAULT_SETTINGS: Settings = { monthlyBudgetCNY: 100, codexPath: '', claudePath: '', autoFallback: false };

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', description: '官方 API，与 ChatGPT 会员分开计费', baseUrls: { responses: 'https://api.openai.com/v1' }, models: [], protocols: ['responses'], website: 'https://openai.com', purchaseUrl: 'https://platform.openai.com', docsUrl: 'https://developers.openai.com/codex/config-advanced/', compatibility: 'Codex 官方 API；需本机验收', note: '请填写 API 控制台可用的模型 ID；官方会员不抵扣 API 账单。' },
  { id: 'anthropic', name: 'Anthropic', description: 'Claude 官方 API，使用自己的 API Key', baseUrls: { anthropic: 'https://api.anthropic.com' }, models: [], protocols: ['anthropic'], website: 'https://www.anthropic.com', purchaseUrl: 'https://platform.claude.com', docsUrl: 'https://code.claude.com/docs/en/authentication', compatibility: 'Claude Code 官方 API；需本机验收', note: '会员登录由官方 CLI 完成；本应用不读取或导出会员凭据。' },
  { id: 'deepseek', name: 'DeepSeek', description: '按量付费，提供两种编程工具接入文档', baseUrls: { responses: 'https://api.deepseek.com', anthropic: 'https://api.deepseek.com/anthropic' }, models: ['deepseek-flash', 'deepseek-v4-pro'], protocols: ['responses', 'anthropic'], website: 'https://www.deepseek.com', purchaseUrl: 'https://platform.deepseek.com', docsUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/', compatibility: '厂商文档支持；未完成本机工具链验收', note: '兼容程度随模型和客户端版本变化，先做小项目验收。' },
  { id: 'bailian-payg', name: '阿里百炼 · 按量', description: '普通模型 API Key，按实际 Token 用量结算', baseUrls: { responses: 'https://dashscope.aliyuncs.com/compatible-mode/v1', anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic' }, models: ['qwen3.8-flash', 'qwen3.8-max', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3', 'kimi-k3'], protocols: ['responses', 'anthropic'], website: 'https://bailian.console.aliyun.com', purchaseUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key', docsUrl: 'https://help.aliyun.com/zh/model-studio/claude-code', compatibility: '北京普通 API；Responses 与 Messages 文档支持', note: '北京地域普通 API Key。模型可手动填写；Codex 和 Claude 使用不同地址。同地域业务空间专属域名也可使用，其他地域请按控制台填写。' },
  { id: 'bailian', name: '阿里百炼 · Token Plan', description: '包月编程套餐；使用专属套餐 Key', baseUrls: { responses: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', anthropic: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic' }, models: ['qwen3.8-flash', 'qwen3.8-max'], protocols: ['responses', 'anthropic'], website: 'https://bailian.console.aliyun.com', purchaseUrl: 'https://www.aliyun.com/benefit/scene/tokenplan', docsUrl: 'https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start', compatibility: '套餐文档支持；需匹配密钥与模型', note: '与普通按量 API 分开计费。仅限本人交互式编程/Agent 使用，不能作为业务应用后端。套餐模型以控制台为准。' },
  { id: 'zhipu-payg', name: '智谱 GLM · 按量', description: '开放平台普通 API，按模型 Token 结算', baseUrls: { responses: 'https://open.bigmodel.cn/api/v1' }, models: ['glm-5.3'], protocols: ['responses'], website: 'https://bigmodel.cn', purchaseUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/responses/introduction', compatibility: '厂商原生 Responses 文档支持；工具链需验收', note: '使用普通开放平台 API Key；不能用 Chat Completions 的 paas/v4 地址替代 Responses。其他模型须核对所选协议支持情况。' },
  { id: 'zhipu', name: '智谱 GLM · Coding Plan', description: '编程套餐；使用对应套餐 API Key', baseUrls: { responses: 'https://open.bigmodel.cn/api/v1', anthropic: 'https://open.bigmodel.cn/api/anthropic' }, models: ['glm-5.3'], protocols: ['responses', 'anthropic'], website: 'https://bigmodel.cn', purchaseUrl: 'https://www.bigmodel.cn/glm-coding', docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/codex', compatibility: 'Codex 与 Claude 厂商接入文档支持', note: '套餐 Key 与普通按量 Key 的额度归属不同；请在套餐控制台确认。实际工具调用仍需验收。' },
  { id: 'minimax', name: 'MiniMax', description: '个人编程套餐，使用套餐 Subscription Key', baseUrls: { anthropic: 'https://api.minimax.io/anthropic' }, models: ['MiniMax-M3.1-Flash-Preview'], protocols: ['anthropic'], website: 'https://www.minimax.io', purchaseUrl: 'https://platform.minimax.cn/subscribe/coding-plan', docsUrl: 'https://platform.minimax.io/docs/m-plan/claude-code', compatibility: 'Claude 厂商文档支持；其他接口请核对', note: '预设为官方国际文档端点；中国区账户请核对控制台提供的端点。' },
  { id: 'kimi-payg', name: 'Kimi · 按量', description: '开放平台普通 API，与 Kimi Code 权益分开', baseUrls: { responses: 'https://api.moonshot.cn/v1', anthropic: 'https://api.moonshot.cn/anthropic' }, models: ['kimi-k3'], protocols: ['responses', 'anthropic'], website: 'https://www.kimi.com', purchaseUrl: 'https://platform.kimi.com', docsUrl: 'https://platform.kimi.com/docs/guide/codex-kimi', compatibility: '原生 Responses 与 Anthropic Messages 文档支持', note: '使用 Kimi 开放平台 Key 与对应模型 ID，不能混用 Code 套餐 Key。更多模型与协议支持以平台文档为准。' },
  { id: 'kimi', name: 'Kimi Code · 套餐', description: '会员编程权益，使用 Kimi Code 专属 Key', baseUrls: { responses: 'https://api.kimi.com/coding/v1', anthropic: 'https://api.kimi.com/coding/' }, models: ['kimi-for-coding', 'k3-256k', 'k3'], protocols: ['responses', 'anthropic'], website: 'https://www.kimi.com', purchaseUrl: 'https://www.kimi.com/code/console', docsUrl: 'https://www.kimi.com/help/kimi-code/third-party-codex', compatibility: 'Codex 与 Claude 厂商文档支持；模型取决于会员档位', note: 'Code 端点需要 Kimi Code 密钥；开放平台密钥、模型 ID 及计费不同。会员权益以控制台为准。' },
  { id: 'openrouter', name: 'OpenRouter', description: '聚合平台，模型及路由按平台计费', baseUrls: { responses: 'https://openrouter.ai/api/v1', anthropic: 'https://openrouter.ai/api', 'chat-completions': 'https://openrouter.ai/api/v1' }, models: [], protocols: ['responses', 'anthropic', 'chat-completions'], website: 'https://openrouter.ai', purchaseUrl: 'https://openrouter.ai/workspaces/default/keys', docsUrl: 'https://openrouter.ai/docs/api_reference/responses/overview', compatibility: 'Responses 文档支持；Codex 完整工具链待实测', note: 'Responses 是无状态接口；Claude 兼容性仅保证 Anthropic 第一方上游，其他模型需实测。' },
  { id: 'groq', name: 'Groq', description: '提供免费层、付费接口及 Responses Beta', baseUrls: { responses: 'https://api.groq.com/openai/v1', 'chat-completions': 'https://api.groq.com/openai/v1' }, models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'], protocols: ['responses', 'chat-completions'], website: 'https://groq.com', purchaseUrl: 'https://console.groq.com/home', docsUrl: 'https://console.groq.com/docs/responses-api', compatibility: 'Responses Beta；Codex 工具链未验收', note: 'Responses 当前不支持 previous_response_id、store、include 等字段，不能仅凭鉴权成功判断 Codex 全功能兼容。' },
];

interface VaultEntry { encrypted: string; masked: string; }
interface SavedState { version: 1; projects: Project[]; connections: Connection[]; settings: Settings; checkpoints: Checkpoint[]; }

function clone<T>(value: T): T { return structuredClone(value); }
function publicConnection(connection: Connection): Connection {
  return { id: connection.id, name: connection.name, presetId: connection.presetId, engine: connection.engine, baseUrl: connection.baseUrl, model: connection.model, protocol: connection.protocol, hasKey: connection.hasKey, testedAt: connection.testedAt, testStatus: connection.testStatus, testMessage: connection.testMessage, ...(connection.pricing ? { pricing: clone(connection.pricing) } : {}), ...(connection.pricingMode ? { pricingMode: connection.pricingMode } : {}) };
}
function atomicWrite(filename: string, value: unknown): void {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, filename); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function readOwnJson<T>(filename: string, fallback: T): T {
  if (!fs.existsSync(filename)) return fallback;
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) as T; }
  catch { throw new Error(`管理器数据文件无法读取：${path.basename(filename)}。请先备份该文件再恢复。`); }
}
export function validateApiBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('API 地址必须是完整 URL。'); }
  if (url.username || url.password || url.hash || url.search) throw new Error('API 地址不能包含用户名、密码、查询参数或片段。');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('API 地址请使用 HTTPS；本机服务可使用 HTTP。');
  return url.toString().replace(/\/+$/, '');
}
export function apiTestEndpoint(baseUrl: string, protocol: Protocol): string {
  const base = validateApiBaseUrl(baseUrl);
  if (protocol === 'anthropic') return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  if (protocol === 'responses') return `${base}/responses`;
  return `${base}/chat/completions`;
}
/** Check before sending a secret; never rewrite the host or billing plan silently. */
export function connectionConfigurationIssue(connection: Pick<Connection, 'engine' | 'protocol' | 'baseUrl' | 'presetId'>): string | undefined {
  const { engine, protocol, presetId } = connection;
  if (engine === 'claude' && protocol !== 'anthropic') return 'Claude Code 需要 Anthropic Messages 协议；请改用供应商的 Anthropic 兼容地址。';
  if (engine === 'codex' && protocol !== 'responses') return 'Codex 需要 Responses 协议；Chat Completions 或 Anthropic Messages 地址不能直接使用。';
  const url = new URL(validateApiBaseUrl(connection.baseUrl));
  if (/\/(responses|messages|chat\/completions)$/i.test(url.pathname)) return 'Base URL 请填写接口根地址，不要包含 /responses、/messages 或 /chat/completions 请求路径。';
  const aliyun = url.hostname.endsWith('.aliyuncs.com') && (url.hostname.includes('dashscope') || url.hostname.includes('.maas.'));
  if (!aliyun) return undefined;
  if (protocol === 'anthropic' && /\/compatible-mode\/v1$/i.test(url.pathname)) {
    const suggested = `${url.origin}/apps/anthropic`;
    return `Claude 地址填成了 Codex/OpenAI 兼容地址。请将 Base URL 改为 ${suggested}，协议保留 Anthropic Messages，再保存并测试；当前没有发送请求。`;
  }
  if (protocol === 'responses' && /\/apps\/anthropic(?:\/v1)?$/i.test(url.pathname)) return `Codex 地址填成了 Claude 兼容地址。请将 Base URL 改为 ${url.origin}/compatible-mode/v1，协议选择 Responses；当前没有发送请求。`;
  const subscriptionHost = url.hostname.startsWith('token-plan.') || url.hostname.startsWith('coding.dashscope.');
  if (presetId === 'bailian-payg' && subscriptionHost) return '选择的是百炼普通按量预设，但地址属于包月套餐。请使用普通 API 地址，或明确选择对应套餐预设与专属 Key；软件不会自动改变计费方案。';
  if (presetId === 'bailian' && !url.hostname.startsWith('token-plan.')) return '选择的是百炼 Token Plan 套餐，但地址不属于 Token Plan。普通 API Key 请改选“阿里百炼 · 按量”；套餐 Key 请使用套餐地址。';
  return undefined;
}
export function validateUsagePricing(pricing: UsagePricing): UsagePricing {
  if (!pricing || pricing.currency !== 'CNY') throw new Error('当前单价请使用人民币 CNY。');
  const fields = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'] as const;
  for (const field of fields) {
    const value = pricing[field];
    if (value === undefined && (field === 'cacheReadPerMillion' || field === 'cacheWritePerMillion')) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000) throw new Error('每百万 Token 单价应为 0～100000 元的有限数字。');
  }
  if (pricing.source !== undefined && (typeof pricing.source !== 'string' || pricing.source.length > 160 || /[\r\n\0]/.test(pricing.source))) throw new Error('单价来源说明无效或过长。');
  if (pricing.updatedAt !== undefined && (typeof pricing.updatedAt !== 'string' || !Number.isFinite(Date.parse(pricing.updatedAt)))) throw new Error('单价更新时间无效。');
  if (pricing.origin !== undefined && !['official','manual'].includes(pricing.origin)) throw new Error('单价来源模式无效。');
  if (pricing.sourceKind !== undefined && !['builtin','network','manual'].includes(pricing.sourceKind)) throw new Error('单价来源类型无效。');
  if (pricing.sourceUrl !== undefined) {
    let url: URL; try { url = new URL(pricing.sourceUrl); } catch { throw new Error('单价来源链接无效。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || pricing.sourceUrl.length > 600) throw new Error('单价来源链接必须是不含凭据的 HTTPS 文档地址。');
  }
  if (pricing.verifiedAt !== undefined && (typeof pricing.verifiedAt !== 'string' || !Number.isFinite(Date.parse(pricing.verifiedAt)))) throw new Error('价格核验时间无效。');
  if (pricing.contextMaxTokens !== undefined && (!Number.isSafeInteger(pricing.contextMaxTokens) || pricing.contextMaxTokens <= 0)) throw new Error('报价上下文上限无效。');
  if (pricing.note !== undefined && (typeof pricing.note !== 'string' || pricing.note.length > 600 || /[\r\n\0]/.test(pricing.note))) throw new Error('报价说明无效或过长。');
  return { currency: 'CNY', inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion, ...(pricing.cacheReadPerMillion !== undefined ? { cacheReadPerMillion: pricing.cacheReadPerMillion } : {}), ...(pricing.cacheWritePerMillion !== undefined ? { cacheWritePerMillion: pricing.cacheWritePerMillion } : {}), ...(pricing.source !== undefined ? { source: pricing.source } : {}), ...(pricing.updatedAt !== undefined ? { updatedAt: pricing.updatedAt } : {}), ...(pricing.origin !== undefined ? { origin: pricing.origin } : {}), ...(pricing.sourceKind !== undefined ? { sourceKind: pricing.sourceKind } : {}), ...(pricing.sourceUrl !== undefined ? { sourceUrl: pricing.sourceUrl } : {}), ...(pricing.verifiedAt !== undefined ? { verifiedAt: pricing.verifiedAt } : {}), ...(pricing.contextMaxTokens !== undefined ? { contextMaxTokens: pricing.contextMaxTokens } : {}), ...(pricing.note !== undefined ? { note: pricing.note } : {}) };
}
function pricingTarget(connection: Pick<Connection,'id'|'name'|'model'|'baseUrl'|'presetId'|'engine'|'protocol'|'pricing'|'pricingMode'>): OfficialPricingTarget {
  return { connectionId: connection.id, name: connection.name, model: connection.model, baseUrl: connection.baseUrl,
    presetId: connection.presetId, engine: connection.engine, protocol: connection.protocol,
    ...(connection.pricing ? { pricing: clone(connection.pricing) } : {}), ...(connection.pricingMode ? { pricingMode: connection.pricingMode } : {}) };
}
function defaultPricing(input: Pick<Connection, 'model' | 'baseUrl' | 'presetId'|'engine'|'protocol'>): UsagePricing | undefined {
  return getBuiltInPricing({ ...input, connectionId: '', name: '' });
}
function legacyOfficial(pricing: UsagePricing): boolean {
  return pricing.currency === 'CNY' && pricing.inputPerMillion === .8 && pricing.outputPerMillion === 2.7
    && pricing.cacheReadPerMillion === .1 && pricing.cacheWritePerMillion === 1.25
    && /^(?:百炼公开价 · |百炼北京公开参考价，核对于 )2026-10-11$/.test(pricing.source || '');
}
function priceMode(connection: Pick<Connection,'pricingMode'|'pricing'>): 'official'|'manual' {
  if (connection.pricingMode === 'manual' || connection.pricing?.origin === 'manual') return 'manual';
  return connection.pricingMode || connection.pricing?.origin
    || (!connection.pricing || legacyOfficial(connection.pricing) ? 'official' : 'manual');
}
function pricingFingerprint(target: OfficialPricingTarget): string {
  return JSON.stringify({ model: target.model, baseUrl: target.baseUrl, presetId: target.presetId, engine: target.engine,
    protocol: target.protocol, pricingMode: target.pricingMode, pricing: target.pricing });
}
export function redactSecrets(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets) if (secret) result = result.split(secret).join('[密钥已隐藏]');
  return result.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[密钥已隐藏]');
}
export function quotePowerShellArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('命令参数包含无效控制字符。');
  return `'${value.replace(/'/g, "''")}'`;
}
export function cliProcessPlan(executable: string, args: string[]): { file: string; args: string[] } {
  if (!/\.(cmd|bat)$/i.test(executable)) return { file: executable, args };
  const command = `& ${[executable, ...args].map(quotePowerShellArgument).join(' ')}`;
  return { file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
}

export class WorkbenchServices {
  readonly dataDir: string;
  private stateFile: string;
  private vaultFile: string;
  private state: SavedState;
  private vault: Record<string, VaultEntry>;
  private memorySecrets = new Map<string, string>();
  private activeTests = new Set<Promise<TestResult>>();

  constructor(dataDir: string, private onUsage?: (capture: UsageCapture) => void) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, 'profiles'), { recursive: true });
    this.stateFile = path.join(this.dataDir, 'workbench.json');
    this.vaultFile = path.join(this.dataDir, 'api-secrets.local.json');
    this.state = readOwnJson(this.stateFile, { version: 1, projects: [], connections: [], settings: { ...DEFAULT_SETTINGS }, checkpoints: [] });
    if (this.state.version !== 1 || !Array.isArray(this.state.projects) || !Array.isArray(this.state.connections) || !Array.isArray(this.state.checkpoints)) throw new Error('管理器数据格式不支持，请保留数据文件并检查版本。');
    this.state.settings = { ...DEFAULT_SETTINGS, ...this.state.settings };
    this.state.connections = this.state.connections.map(publicConnection);
    this.vault = readOwnJson(this.vaultFile, {});
    this.migratePricing();
  }
  private persist(): void { atomicWrite(this.stateFile, this.state); }
  getProjects(): Project[] { return clone(this.state.projects); }
  getPresets(): ProviderPreset[] { return clone(PROVIDER_PRESETS); }
  getSettings(): Settings { return clone(this.state.settings); }
  getCheckpoints(): Checkpoint[] { return clone(this.state.checkpoints); }
  private migratePricing(): void {
    const before = JSON.stringify(this.state.connections);
    for (const connection of this.state.connections) {
      const builtIn = defaultPricing(connection);
      const mode = !connection.pricingMode && !connection.pricing?.origin && connection.pricing && legacyOfficial(connection.pricing) && !builtIn ? 'manual' : priceMode(connection);
      connection.pricingMode = mode;
      if (connection.pricing) {
        const price = validateUsagePricing(connection.pricing);
        if (mode === 'manual') connection.pricing = { ...price, origin: 'manual', sourceKind: 'manual' };
        else connection.pricing = { ...price, origin: 'official', sourceKind: price.sourceKind === 'network' ? 'network' : 'builtin',
          ...(legacyOfficial(price) && builtIn ? { cacheWritePerMillion: builtIn.cacheWritePerMillion, sourceUrl: builtIn.sourceUrl, verifiedAt: builtIn.verifiedAt } : {}) };
      } else if (mode === 'official' && builtIn) connection.pricing = validateUsagePricing(builtIn);
    }
    if (before !== JSON.stringify(this.state.connections)) this.persist();
  }
  getPricingTargets(connectionIds?: string[]): OfficialPricingTarget[] {
    const ids = connectionIds ? new Set(connectionIds) : undefined;
    return this.state.connections.filter(connection => !ids || ids.has(connection.id)).map(pricingTarget);
  }
  applyOfficialPricing(results: OfficialPricingResult[], startedTargets: OfficialPricingTarget[], forceManual = false): OfficialPricingRefreshReport {
    const started = new Map(startedTargets.map(target => [target.connectionId, target]));
    let changed = false;
    const applied: OfficialPricingResult[] = results.map(result => {
      const original = started.get(result.connectionId), current = this.state.connections.find(connection => connection.id === result.connectionId);
      if (!original || !current || pricingFingerprint(pricingTarget(current)) !== pricingFingerprint(original)) return { connectionId: result.connectionId, status: 'changed-skipped', message: '联网期间连接或单价已改变，保留当前设置。' };
      if (priceMode(current) === 'manual' && !forceManual) return { connectionId: current.id, status: 'manual-skipped', message: '保留手工单价；可对该连接主动选择使用官方报价。', ...(current.pricing ? { pricing: clone(current.pricing) } : {}) };
      if (!['updated','unchanged'].includes(result.status) || !result.pricing) return clone(result);
      const price = validateUsagePricing({ ...result.pricing, origin: 'official', sourceKind: 'network' });
      current.pricing = price; current.pricingMode = 'official'; changed = true;
      return { ...clone(result), status: result.status, pricing: clone(price) };
    });
    if (changed) this.persist();
    return { updatedAt: new Date().toISOString(), results: applied,
      updatedCount: applied.filter(row => row.status === 'updated').length,
      manualSkippedCount: applied.filter(row => row.status === 'manual-skipped').length,
      unsupportedCount: applied.filter(row => row.status === 'unsupported').length,
      failedCount: applied.filter(row => row.status === 'failed').length,
      warnings: applied.filter(row => ['failed','unsupported','changed-skipped'].includes(row.status)).map(row => row.message) };
  }
  getConnections(): Connection[] {
    return this.state.connections.map(connection => ({ ...publicConnection(connection), hasKey: Boolean(this.getSecret(connection.id)), maskedKey: this.vault[connection.id]?.masked || (this.memorySecrets.has(connection.id) ? '仅本次运行保存' : undefined) }));
  }
  getConnection(id: string): Connection | undefined { return this.getConnections().find(connection => connection.id === id); }
  addProject(input: { name: string; path: string }): Project {
    const projectPath = path.resolve(input.path);
    if (!fs.statSync(projectPath).isDirectory()) throw new Error('项目路径必须是已有文件夹。');
    const existing = this.state.projects.find(project => project.path.toLowerCase() === projectPath.toLowerCase());
    if (existing) return clone(existing);
    const project: Project = { id: randomUUID(), name: input.name.trim() || path.basename(projectPath), path: projectPath, createdAt: new Date().toISOString() };
    this.state.projects.push(project); this.persist(); return clone(project);
  }
  removeProject(id: string): void { this.state.projects = this.state.projects.filter(project => project.id !== id); this.persist(); }
  saveConnection(input: ConnectionInput): Connection {
    if (!input.name.trim() || !input.model.trim()) throw new Error('请填写连接名称与模型 ID。');
    if (!['codex', 'claude'].includes(input.engine) || !['responses', 'anthropic', 'chat-completions'].includes(input.protocol)) throw new Error('引擎或接口协议无效。');
    if (/[\r\n\0]/.test(input.model) || input.model.length > 250) throw new Error('模型 ID 包含无效字符或过长。');
    const baseUrl = validateApiBaseUrl(input.baseUrl);
    const configurationIssue = connectionConfigurationIssue({ ...input, baseUrl });
    if (configurationIssue) throw new Error(configurationIssue);
    const previous = input.id ? this.state.connections.find(connection => connection.id === input.id) : undefined;
    if (input.id && !previous) throw new Error('连接不存在，请刷新后重试。');
    const samePriceScope = previous && previous.model === input.model.trim() && previous.presetId === input.presetId && new URL(previous.baseUrl).origin === new URL(baseUrl).origin;
    // An omitted price keeps an existing manual quote. Never replace it with a
    // refreshed preset quote; changes of model/provider discard the old quote.
    const pricingMode = input.pricing !== undefined ? 'manual' : samePriceScope ? priceMode(previous) : 'official';
    const pricing = input.pricing !== undefined ? { ...validateUsagePricing(input.pricing), origin: 'manual' as const, sourceKind: 'manual' as const } : samePriceScope ? previous.pricing : defaultPricing({ ...input, model: input.model.trim(), baseUrl });
    const id = previous?.id || randomUUID();
    if (input.apiKey?.trim()) {
      const key = input.apiKey.trim();
      if (/[\r\n\0]/.test(key)) throw new Error('API Key 包含无效字符。');
      const host = new URL(baseUrl).hostname;
      if (host.endsWith('.aliyuncs.com') && /^LTAI[A-Za-z0-9]+$/.test(key)) throw new Error('这是阿里云 AccessKey ID，不能用作模型 API Key。请到百炼 API Key 页面创建普通模型 Key。');
      if (host === 'dashscope.aliyuncs.com' && key.startsWith('sk-sp-')) throw new Error('这是 Token Plan 专属 Key，不能填入普通按量地址。请使用对应套餐预设与套餐端点。');
      if (safeStorage?.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(key).toString('base64');
        this.vault[id] = { encrypted, masked: `••••${key.slice(-4)}` };
        atomicWrite(this.vaultFile, this.vault); this.memorySecrets.delete(id);
      } else { this.memorySecrets.set(id, key); delete this.vault[id]; atomicWrite(this.vaultFile, this.vault); }
    }
    const connection: Connection = { id, name: input.name.trim(), presetId: input.presetId, engine: input.engine, baseUrl, model: input.model.trim(), protocol: input.protocol, hasKey: Boolean(this.getSecret(id)), testStatus: 'untested', pricingMode, ...(pricing ? { pricing: clone(pricing) } : {}) };
    this.state.connections = [...this.state.connections.filter(item => item.id !== id), connection];
    this.persist(); return this.getConnection(id)!;
  }
  savePricing(connectionId: string, pricing: UsagePricing | null): Connection {
    const connection = this.state.connections.find(item => item.id === connectionId);
    if (!connection) throw new Error('连接不存在。');
    connection.pricingMode = 'manual';
    if (pricing === null) delete connection.pricing;
    else connection.pricing = { ...validateUsagePricing(pricing), origin: 'manual', sourceKind: 'manual' };
    this.persist();
    return this.getConnection(connectionId)!;
  }
  deleteConnection(id: string): void {
    delete this.vault[id]; this.memorySecrets.delete(id); atomicWrite(this.vaultFile, this.vault);
    this.state.connections = this.state.connections.filter(connection => connection.id !== id);
    if (this.state.settings.fallbackConnectionId === id) delete this.state.settings.fallbackConnectionId;
    this.persist();
  }
  getSecret(id: string): string | undefined {
    if (this.memorySecrets.has(id)) return this.memorySecrets.get(id);
    const record = this.vault[id];
    if (!record?.encrypted || !safeStorage?.isEncryptionAvailable()) return undefined;
    try { return safeStorage.decryptString(Buffer.from(record.encrypted, 'base64')); } catch { return undefined; }
  }
  saveSettings(input: Partial<Settings>): Settings {
    const next = { ...this.state.settings, ...input };
    if (!Number.isFinite(next.monthlyBudgetCNY) || next.monthlyBudgetCNY < 0 || next.monthlyBudgetCNY > 100000) throw new Error('月预算应为 0～100000 元。');
    if (typeof next.autoFallback !== 'boolean') throw new Error('设置格式无效。');
    const pathFields = ['codexPath', 'claudePath', 'codexDesktopPath', 'codexConfigPath', 'claudeConfigPath', 'claudeLaunchDirectory', 'claudeDesktopPath', 'claudeDesktopConfigDir'] as const;
    for (const field of pathFields) {
      const value = next[field];
      if (value === undefined && !Object.prototype.hasOwnProperty.call(input, field)) continue;
      if (typeof value !== 'string') throw new Error(`${field} 必须是字符串；留空可清除。`);
      if (/[\r\n\0]/.test(value)) throw new Error(`${field} 包含无效控制字符。`);
      const normalized = value.trim();
      if (normalized && !path.isAbsolute(normalized)) throw new Error(`${field} 必须使用绝对路径。`);
      next[field] = normalized;
    }
    this.state.settings = next; this.persist(); return clone(next);
  }
  saveCheckpoint(checkpoint: Checkpoint): void {
    this.state.checkpoints = [clone(checkpoint), ...this.state.checkpoints.filter(item => item.id !== checkpoint.id)].slice(0, 500);
    this.persist();
  }
  async diagnose(): Promise<RuntimeDiagnostic[]> {
    return Promise.all((['codex', 'claude'] as const).map(async engine => {
      let executable = engine === 'codex' ? this.state.settings.codexPath.trim() : this.state.settings.claudePath.trim();
      try {
        if (executable && !fs.existsSync(executable)) throw new Error('选择的程序文件不存在。');
        if (!executable) {
          const detected = await execFileAsync('where.exe', [engine], { windowsHide: true, timeout: 5000 });
          const candidates = detected.stdout.trim().split(/\r?\n/).filter(candidate => fs.existsSync(candidate));
          executable = candidates.find(candidate => /\.exe$/i.test(candidate)) || candidates.find(candidate => /\.(cmd|bat)$/i.test(candidate)) || '';
          if (!executable) throw new Error('未在 PATH 中找到官方命令行程序。');
        }
        const plan = cliProcessPlan(executable, ['--version']);
        const env = { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CONFIG_DIR: path.join(this.dataDir, 'profiles', 'claude') };
        const version = await execFileAsync(plan.file, plan.args, { windowsHide: true, timeout: 12000, maxBuffer: 64 * 1024, env });
        return { engine, available: true, path: executable, version: version.stdout.trim().split(/\r?\n/)[0]?.slice(0, 160), message: '程序可运行；尚未验证登录、网络和模型工具链。' };
      } catch (error) {
        return { engine, available: false, path: executable, message: redactSecrets(error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error)).slice(0, 250) };
      }
    }));
  }
  testConnection(id: string): Promise<TestResult> {
    const task = this.executeConnectionTest(id);
    this.activeTests.add(task);
    void task.then(() => this.activeTests.delete(task), () => this.activeTests.delete(task));
    return task;
  }
  async waitForTests(): Promise<void> {
    while (this.activeTests.size) await Promise.allSettled([...this.activeTests]);
  }
  private async executeConnectionTest(id: string): Promise<TestResult> {
    const start = Date.now();
    const connection = this.getConnection(id);
    if (!connection) throw new Error('连接不存在。');
    const key = this.getSecret(id);
    const complete = (ok: boolean, message: string): TestResult => {
      const result: TestResult = { ok, status: ok ? 'auth-ok' : 'failed', message: redactSecrets(message, key ? [key] : []), elapsedMs: Date.now() - start };
      const record = this.state.connections.find(item => item.id === id);
      if (record) { record.testedAt = new Date().toISOString(); record.testStatus = result.status; record.testMessage = result.message; this.persist(); }
      return result;
    };
    const configurationIssue = connectionConfigurationIssue(connection);
    if (configurationIssue) return complete(false, configurationIssue);
    if (!key) return complete(false, '没有可解密的 API Key；换机后需要重新填写。');
    let attempted = false, httpStatus = 0, requestOK = false;
    let tokens: UsageCapture['tokens'] = null;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
      let body: Record<string, unknown>;
      if (connection.protocol === 'anthropic') {
        headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
        body = { model: connection.model.replace(/\[1m\]$/, ''), max_tokens: 32, messages: [{ role: 'user', content: 'Reply with OK.' }] };
      } else body = { model: connection.model, input: 'Reply with OK.', max_output_tokens: 32 };
      const testHost = new URL(connection.baseUrl).hostname;
      // The known Qwen model otherwise spends the tiny test allowance thinking
      // and returns incomplete. This affects only the diagnostic request.
      if (testHost.endsWith('.aliyuncs.com') && ['qwen3.8-flash', 'qwen3.8-max'].includes(String(body.model))) {
        if (connection.protocol === 'anthropic') body.thinking = { type: 'disabled' };
        else body.reasoning = { effort: 'none' };
      }
      const endpoint = apiTestEndpoint(connection.baseUrl, connection.protocol);
      attempted = true;
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error' });
      httpStatus = response.status;
      const responseText = (await response.text()).slice(0, 65536);
      let parsed: Record<string, unknown> | undefined;
      try { const json: unknown = JSON.parse(responseText); if (json && typeof json === 'object' && !Array.isArray(json)) parsed = json as Record<string, unknown>; } catch { /* Do not save untrusted response bodies. */ }
      tokens = normalizeUsage(parsed?.usage, connection.protocol) ?? null;
      if (!response.ok) {
        let detail = '';
        try { const json = JSON.parse(responseText); detail = String(json.error?.message || json.message || '').slice(0, 300); } catch { /* HTML errors should not enter application logs. */ }
        const explanation = response.status === 404 ? '没有找到请求接口或模型。请核对 Base URL 与接口协议是否对应；404 不能证明密钥无效或余额不足。'
          : response.status === 401 ? '鉴权失败。请核对 API Key、地域和端点是否配套；会员登录凭据不能代替模型 API Key。'
          : response.status === 403 ? '服务拒绝访问。请检查模型权限、地域限制或供应商返回的具体原因。'
          : response.status === 429 ? '达到调用频率或供应商额度限制，请查看控制台的具体限制。'
          : response.status >= 500 ? '供应商服务暂时异常，请稍后重试。'
          : '请求被拒绝，请按供应商返回的错误信息核对配置。';
        return complete(false, `HTTP ${response.status}：${explanation}${detail ? ` 供应商说明：${detail}` : ''}`);
      }
      if (!parsed) return complete(false, '接口没有返回预期 JSON，请检查协议与 Base URL。');
      const json = parsed;
      const providerFailure = json.status === 'failed' || json.type === 'error' || Boolean(json.error);
      if (providerFailure) {
        const error = json.error;
        const detail = error && typeof error === 'object' && !Array.isArray(error) && typeof (error as Record<string, unknown>).message === 'string' ? String((error as Record<string, unknown>).message).slice(0, 300) : '';
        return complete(false, `HTTP 200，但模型报告请求失败${detail ? `：${detail}` : '。请查看供应商的接口协议和模型支持情况。'}`);
      }
      if (json.status === 'incomplete' || json.stop_reason === 'max_tokens') return complete(false, 'API 已响应，但模型回复达到测试输出上限而未完成；不能据此确认连接测试通过。可能仍产生 Token 费用，已记录返回的用量。');
      const valid = connection.protocol === 'anthropic' ? Array.isArray(json.content) : Array.isArray(json.output);
      if (!valid) return complete(false, '请求成功，但响应结构与所选协议不匹配。');
      requestOK = true;
      return complete(true, '鉴权与一次小额模型请求成功；尚未验证 CLI 工具调用、文件修改与会话恢复。');
    } catch (error) { return complete(false, error instanceof Error && error.name === 'TimeoutError' ? '连接测试超时，请检查网络或稍后重试。' : `连接测试失败：${error instanceof Error ? error.message : String(error)}`); }
    finally {
      if (attempted && this.onUsage) {
        try { this.onUsage({ connectionId: connection.id, connectionName: connection.name, engine: connection.engine, model: connection.model.replace(/\[1m\]$/, ''), startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), httpStatus, outcome: requestOK ? 'success' : 'error', tokens, kind: 'connection-test', pricing: connection.pricing }); }
        catch { /* Accounting cannot change the result of a connection test. */ }
      }
    }
  }
}
