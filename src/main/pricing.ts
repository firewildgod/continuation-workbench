import type { OfficialPricingResult, OfficialPricingTarget, UsagePricing } from '../shared/usage';

type SupportedModel = 'qwen3.8-flash' | 'qwen3.8-max';
const SOURCE_URLS: Record<SupportedModel, string> = {
  'qwen3.8-flash': 'https://help.aliyun.com/zh/model-studio/qwen3-8-flash',
  'qwen3.8-max': 'https://help.aliyun.com/zh/model-studio/qwen3-8-max',
};
const SNAPSHOT_DATE = '2026-10-11T00:00:00+08:00';
const MAX_PAGE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 2;
const SCOPE_NOTE = '北京地域普通按量原价，不含免费额度、活动及企业优惠。';

class PriceSourceError extends Error {}

/** Scope is resolved from public connection metadata, never from keys or a user-supplied source URL. */
function supportedModel(target: OfficialPricingTarget): SupportedModel | undefined {
  if (target.model !== 'qwen3.8-flash' && target.model !== 'qwen3.8-max') return undefined;
  if (target.presetId !== 'custom' && target.presetId !== 'bailian-payg') return undefined;
  let base: URL;
  try { base = new URL(target.baseUrl); } catch { return undefined; }
  if (base.protocol !== 'https:' || base.username || base.password || base.port || base.search || base.hash) return undefined;
  const host = base.hostname.toLowerCase();
  const workspace = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cn-beijing\.maas\.aliyuncs\.com$/.exec(host);
  if (host !== 'dashscope.aliyuncs.com' && (!workspace || /^(?:token-?plan|coding-?plan)$/i.test(workspace[1]))) return undefined;
  // A legacy Claude connection may still use the Codex path. A quote does not repair or activate its route.
  if (!['/compatible-mode/v1', '/apps/anthropic', '/apps/anthropic/v1'].includes(base.pathname.replace(/\/$/, ''))) return undefined;
  return target.model;
}

function quote(model: SupportedModel, values: Pick<UsagePricing, 'inputPerMillion' | 'outputPerMillion' | 'cacheReadPerMillion' | 'cacheWritePerMillion'>, date: string, sourceKind: 'builtin' | 'network', extraNote = ''): UsagePricing {
  return {
    currency: 'CNY', ...values, origin: 'official', sourceKind,
    source: '百炼官网 · 北京按量', sourceUrl: SOURCE_URLS[model],
    updatedAt: date, verifiedAt: date, note: `${SCOPE_NOTE}${extraNote}`,
  };
}

/** A dated local snapshot keeps supported connections usable before the first online refresh. */
export function getBuiltInPricing(target: OfficialPricingTarget): UsagePricing | undefined {
  const model = supportedModel(target);
  if (model === 'qwen3.8-flash') return quote(model, { inputPerMillion: 0.8, outputPerMillion: 2.7, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25 }, SNAPSHOT_DATE, 'builtin');
  if (model === 'qwen3.8-max') return quote(model, { inputPerMillion: 12, outputPerMillion: 36, cacheWritePerMillion: 15 }, SNAPSHOT_DATE, 'builtin', '隐式缓存命中 1.5 元/百万，显式缓存命中 1 元/百万；用量字段无法区分，缓存读取暂不计价。');
  return undefined;
}

interface HtmlNode { tag: string; attrs: Record<string, string>; text?: string; children: HtmlNode[]; parent?: HtmlNode; }
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const point = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : match;
    }
    return named[entity.toLowerCase()] || match;
  });
}
function normalized(text: string): string { return decodeEntities(text).replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/\s+/g, ''); }
function nodeText(node: HtmlNode): string { return node.tag === '#text' ? node.text || '' : node.children.map(nodeText).join(''); }
function descendants(node: HtmlNode, tag: string): HtmlNode[] {
  const result: HtmlNode[] = [];
  const visit = (current: HtmlNode) => { if (current.tag === tag) result.push(current); current.children.forEach(visit); };
  visit(node); return result;
}

/** Small, non-executing HTML tree reader for the official article's explicit table markup. */
function htmlTree(html: string): HtmlNode {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const tokens = html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (!token.startsWith('<')) { stack[stack.length - 1].children.push({ tag: '#text', attrs: {}, text: token, children: [] }); continue; }
    const close = /^<\/([\w-]+)\s*>$/.exec(token);
    if (close) {
      const name = close[1].toLowerCase();
      if (stack.length < 2 || stack[stack.length - 1].tag !== name) throw new PriceSourceError('官网正文结构已变化，未更新单价。');
      stack.pop(); continue;
    }
    const open = /^<([\w-]+)\b([\s\S]*?)\/?\s*>$/.exec(token);
    if (!open) throw new PriceSourceError('官网正文标记无法校验，未更新单价。');
    const name = open[1].toLowerCase();
    if (name === 'script' || name === 'style') throw new PriceSourceError('官网正文出现非表格脚本内容，未更新单价。');
    const attrs: Record<string, string> = {};
    for (const item of open[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) attrs[item[1].toLowerCase()] = item[2] ?? item[3] ?? item[4];
    const node: HtmlNode = { tag: name, attrs, children: [], parent: stack[stack.length - 1] };
    stack[stack.length - 1].children.push(node);
    if (!VOID_TAGS.has(name) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  if (stack.length !== 1) throw new PriceSourceError('官网正文表格未完整闭合，未更新单价。');
  return root;
}

function jsonObjectAt(script: string, start: number): string {
  let depth = 0; let inString = false; let escaped = false;
  for (let index = start; index < script.length; index++) {
    const char = script[index];
    if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return script.slice(start, index + 1);
  }
  throw new PriceSourceError('官网文章数据不完整，未更新单价。');
}

function officialArticle(model: SupportedModel, pageHtml: string): string {
  const assignments: string[] = [];
  for (const script of pageHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    for (const assignment of script[1].matchAll(/\bwindow\.__ICE_PAGE_PROPS__\s*=\s*(?=\{)/g)) assignments.push(jsonObjectAt(script[1], assignment.index! + assignment[0].length));
  }
  if (assignments.length !== 1) throw new PriceSourceError('官网文章数据格式已变化，未更新单价。');
  let data: { docDetailData?: { storeData?: { data?: { docTitle?: unknown; content?: unknown } } } };
  try { data = JSON.parse(assignments[0]); } catch { throw new PriceSourceError('官网文章 JSON 无法校验，未更新单价。'); }
  const article = data.docDetailData?.storeData?.data;
  if (!article || article.docTitle !== model || typeof article.content !== 'string' || article.content.length > MAX_PAGE_BYTES) throw new PriceSourceError('官网模型标识或正文范围不匹配，未更新单价。');
  return article.content;
}

function rate(text: string): number {
  const clean = normalized(text);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(clean)) throw new PriceSourceError('官网价格不是可校验的人民币数值，未更新单价。');
  const value = Number(clean);
  if (!Number.isFinite(value) || value < 0 || value > 100_000) throw new PriceSourceError('官网价格数值超出支持范围，未更新单价。');
  return value;
}

/** Exact model, model-price heading, Beijing section, row labels and units are all checked. */
export function parseBailianPricingPage(model: SupportedModel, pageHtml: string, verifiedAt = new Date().toISOString()): UsagePricing {
  if (!(model in SOURCE_URLS) || !Number.isFinite(Date.parse(verifiedAt))) throw new PriceSourceError('报价模型或验证日期无效。');
  const root = htmlTree(officialArticle(model, pageHtml));
  const headings = descendants(root, 'h2').filter(node => normalized(nodeText(node)) === '模型价格');
  if (headings.length !== 1 || !headings[0].parent) throw new PriceSourceError('官网模型价格章节无法唯一定位，未更新单价。');
  const siblings = headings[0].parent.children;
  const start = siblings.indexOf(headings[0]) + 1;
  const nextHeading = siblings.findIndex((node, index) => index >= start && node.tag === 'h2');
  const scope: HtmlNode = { tag: '#root', attrs: {}, children: siblings.slice(start, nextHeading < 0 ? undefined : nextHeading) };
  const regions = descendants(scope, 'section').filter(node => node.children.some(child => child.tag === 'h4' && normalized(nodeText(child)) === '华北2(北京)'));
  if (regions.length !== 1) throw new PriceSourceError('官网北京地域价格无法唯一定位，未更新单价。');
  if (/(?:上下文|输入长度|阶梯|\d+(?:K|M)(?:tokens|Token))/i.test(normalized(nodeText(regions[0])))) throw new PriceSourceError('官网北京价格出现上下文档位，当前不自动选择档位，保留原单价。');
  const tables = descendants(regions[0], 'table');
  if (tables.length !== 1) throw new PriceSourceError('官网北京价格表数量已变化，未更新单价。');
  const rows = descendants(tables[0], 'tr');
  const headerCells = rows.shift()?.children.filter(node => node.tag === 'th');
  if (headerCells?.some(node => (node.attrs.rowspan && node.attrs.rowspan !== '1') || (node.attrs.colspan && node.attrs.colspan !== '1'))) throw new PriceSourceError('官网价格列或上下文档位已变化，未更新单价。');
  const header = headerCells?.map(node => normalized(nodeText(node)));
  if (!header || header.join('|') !== '计费项|价格(元)|单位') throw new PriceSourceError('官网价格列或上下文档位已变化，未更新单价。');
  const prices = new Map<string, number>();
  const recognized = new Set(['输入', '输出', '输入(缓存命中)', '显式缓存创建', '显式缓存命中']);
  for (const row of rows) {
    const cells = row.children.filter(node => node.tag === 'td' || node.tag === 'th');
    if (cells.length !== 3 || cells.some(node => (node.attrs.rowspan && node.attrs.rowspan !== '1') || (node.attrs.colspan && node.attrs.colspan !== '1'))) throw new PriceSourceError('官网价格阶梯或合并列已变化，未更新单价。');
    const label = normalized(nodeText(cells[0]));
    if (/^(?:输入|输出)\(Batch(?:File|Chat)\)$/.test(label)) continue;
    if (!recognized.has(label)) throw new PriceSourceError('官网计费项或上下文阶梯已变化，未更新单价。');
    if (normalized(nodeText(cells[2])) !== '每百万tokens') throw new PriceSourceError('官网计费单位已变化，未更新单价。');
    if (prices.has(label)) throw new PriceSourceError('官网计费项重复，未更新单价。');
    prices.set(label, rate(nodeText(cells[1])));
  }
  if (!prices.has('输入') || !prices.has('输出')) throw new PriceSourceError('官网缺少标准输入或输出价格，未更新单价。');
  const implicit = prices.get('输入(缓存命中)');
  const explicit = prices.get('显式缓存命中');
  const cacheWrite = prices.get('显式缓存创建');
  const sameReadRate = implicit !== undefined && explicit !== undefined && implicit === explicit;
  let note = '';
  if (implicit !== undefined && explicit !== undefined && implicit !== explicit) note += `隐式缓存命中 ${implicit} 元/百万，显式缓存命中 ${explicit} 元/百万；用量字段无法区分，缓存读取暂不计价。`;
  else if (!sameReadRate) note += '官网未提供两种缓存读取的完整价格，缓存读取暂不计价。';
  if (cacheWrite === undefined) note += '官网缺少显式缓存创建单价，该项暂不计价。';
  return quote(model, {
    inputPerMillion: prices.get('输入')!, outputPerMillion: prices.get('输出')!,
    ...(sameReadRate ? { cacheReadPerMillion: implicit } : {}),
    ...(cacheWrite !== undefined ? { cacheWritePerMillion: cacheWrite } : {}),
  }, verifiedAt, 'network', note);
}

function permittedSource(url: URL, source: URL): boolean {
  return url.protocol === 'https:' && url.hostname === 'help.aliyun.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/$/, '') === source.pathname;
}
async function boundedHtml(response: Response): Promise<string> {
  const size = response.headers.get('content-length');
  if (size && /^\d+$/.test(size) && Number(size) > MAX_PAGE_BYTES) { await response.body?.cancel(); throw new PriceSourceError('官网响应超过安全大小限制，未更新单价。'); }
  const reader = response.body?.getReader();
  if (!reader) throw new PriceSourceError('官网响应正文为空，未更新单价。');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_PAGE_BYTES) { await reader.cancel(); throw new PriceSourceError('官网响应超过安全大小限制，未更新单价。'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

interface FetchOptions { fetch?: typeof fetch; timeoutMs?: number; }
async function fetchModel(model: SupportedModel, options: FetchOptions): Promise<UsagePricing> {
  const source = new URL(SOURCE_URLS[model]);
  const controller = new AbortController();
  const requestedTimeout = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(30_000, Math.max(1, requestedTimeout));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PriceSourceError('官网价格读取超时，保留原单价。')); }, timeoutMs); });
  const read = async () => {
    let current = source;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await (options.fetch ?? fetch)(current.href, { method: 'GET', headers: { Accept: 'text/html' }, redirect: 'manual', credentials: 'omit', signal: controller.signal });
      if (response.url && !permittedSource(new URL(response.url), source)) throw new PriceSourceError('官网响应来源无法校验，保留原单价。');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === MAX_REDIRECTS) throw new PriceSourceError('官网重定向次数或目标异常，保留原单价。');
        const redirected = new URL(location, current);
        if (!permittedSource(redirected, source)) throw new PriceSourceError('官网重定向离开固定价格来源，保留原单价。');
        current = redirected; continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new PriceSourceError(`官网价格页返回 HTTP ${response.status}，保留原单价。`); }
      if (!(response.headers.get('content-type') || '').toLowerCase().startsWith('text/html')) { await response.body?.cancel(); throw new PriceSourceError('官网价格页格式不是 HTML，保留原单价。'); }
      return parseBailianPricingPage(model, await boundedHtml(response));
    }
    throw new PriceSourceError('官网重定向无法校验，保留原单价。');
  };
  try { return await Promise.race([read(), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}

/** Network fetches public documentation only; persistence and manual-price policy belong to the caller. */
export async function fetchOfficialPricing(targets: OfficialPricingTarget[], options: FetchOptions = {}): Promise<OfficialPricingResult[]> {
  const pending = new Map<SupportedModel, Promise<UsagePricing>>();
  return Promise.all(targets.map(async target => {
    const model = supportedModel(target);
    if (!model) return { connectionId: target.connectionId, status: 'unsupported' as const, message: '当前仅自动报价北京普通百炼 qwen3.8-flash / qwen3.8-max；其他地域、套餐或模型暂需手动单价。' };
    if (!pending.has(model)) pending.set(model, fetchModel(model, options));
    try {
      const pricing = await pending.get(model)!;
      return { connectionId: target.connectionId, status: 'updated' as const, message: '已读取并校验官网北京普通按量价格。', pricing: { ...pricing } };
    } catch (error) {
      return { connectionId: target.connectionId, status: 'failed' as const, message: error instanceof PriceSourceError ? error.message : '官网价格读取失败，保留原单价，请稍后再试。' };
    }
  }));
}
