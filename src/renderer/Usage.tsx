import { useEffect, useRef, useState } from 'react';
import type { AppState, Connection, OfficialPricingRefreshInput, OfficialPricingRefreshReport, OfficialPricingResult, UsagePricing, UsageRecord, UsageSummary, UsageTotals } from '../shared/types';
import { Button, Empty, Field, Notice, Panel, Pill } from './components';
import { Icon } from './Icon';

const blankTotals: UsageTotals = { costCNY: 0, knownCostCNY: 0, requestCount: 0, successCount: 0, failedCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, unpricedRequests: 0, unknownUsageRequests: 0, pricedRequests: 0 };
export const emptyUsage: UsageSummary = { timezone: 'Asia/Shanghai', today: { ...blankTotals }, month: { ...blankTotals }, daily: [], byConnection: [], byModel: [], records: [], startedAt: null };
export const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
export const money = (value: number | null, known = 0): string => value === null ? known > 0 ? `已知 ¥${known.toFixed(known < .001 ? 6 : 3)}` : '—' : value > 0 && value < .001 ? '< ¥0.001' : `¥${value.toFixed(value > 10 ? 2 : 3)}`;
const compact = (value: number) => value >= 1000000 ? `${(value / 1000000).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
const requestTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const quoteTime = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const manualPricing = (connection: Connection) => connection.pricingMode === 'manual' || connection.pricing?.origin === 'manual' || connection.pricing?.sourceKind === 'manual' || (!!connection.pricing && !connection.pricing.origin && connection.pricing.sourceKind !== 'builtin' && connection.pricing.sourceKind !== 'network');
const PRICE_RESULT_LABELS: Record<OfficialPricingResult['status'], string> = { updated: '已更新', unchanged: '已核对', 'manual-skipped': '保留手动价', unsupported: '暂未支持', failed: '更新失败', 'changed-skipped': '配置已变更' };

export function UsageCards({ usage, onDetails }: { usage: UsageSummary; onDetails?: () => void }) {
  const cards = [
    { label: '今日费用', value: money(usage.today.costCNY, usage.today.knownCostCNY), sub: `${number(usage.today.requestCount)} 次请求`, unknown: usage.today.unpricedRequests + usage.today.unknownUsageRequests > 0 },
    { label: '本月累计', value: money(usage.month.costCNY, usage.month.knownCostCNY), sub: '本机记录 · 人民币估算', unknown: usage.month.unpricedRequests + usage.month.unknownUsageRequests > 0 },
    { label: '本月请求', value: number(usage.month.requestCount), sub: `${number(usage.month.successCount)} 成功 · ${number(usage.month.failedCount)} 未成功` },
    { label: '本月 Token', value: usage.month.unknownUsageRequests > 0 && usage.month.inputTokens + usage.month.outputTokens === 0 ? '—' : compact(usage.month.inputTokens + usage.month.outputTokens), sub: `输入 ${compact(usage.month.inputTokens)} · 输出 ${compact(usage.month.outputTokens)}${usage.month.unknownUsageRequests ? ` · ${usage.month.unknownUsageRequests} 次未知` : ''}` },
  ];
  return <div className="usage-cards">{cards.map((card, index) => <div className={`usage-card ${index === 0 ? 'featured' : ''}`} key={card.label}><div className="metric-label">{card.label}{card.unknown && <span className="unknown-label">待补全</span>}</div><div className="metric-value">{card.value}</div><div className="metric-sub">{card.sub}</div>{index === 1 && onDetails && <button className="metric-link" onClick={onDetails} aria-label="查看用量与费用"><Icon name="arrow" /></button>}</div>)}</div>;
}

export function UsageTrend({ usage }: { usage: UsageSummary }) {
  const days = usage.daily.slice(-7);
  const max = Math.max(...days.map(day => day.knownCostCNY), .001);
  return <Panel title="近 7 日费用" icon="chart" actions={<span className="panel-caption">人民币 · 本机估算</span>} className="trend-panel">{days.length ? <><div className="bar-chart">{days.map(day => <div className="chart-column" key={day.date}><span className="chart-amount">{money(day.costCNY, day.knownCostCNY)}</span><div className="chart-track"><div className={`chart-bar ${day.costCNY === null ? 'incomplete' : ''}`} style={{ height: `${day.knownCostCNY ? Math.max(day.knownCostCNY / max * 100, 5) : day.costCNY === null ? 12 : 2}%` }} title={`${day.date}：${day.requestCount} 次请求；${day.costCNY === null ? '部分费用未知' : money(day.costCNY)}`} /></div><span className="chart-date">{day.date.slice(5).replace('-', '/')}</span></div>)}</div><div className="chart-legend"><span><i />已估算费用</span><span><i className="hatched" />部分用量或价格缺失</span></div></> : <Empty icon="chart" title="等待第一条用量记录" description="通过本机网关调用后，这里会显示费用趋势。之前的消费不会自动补入。" />}</Panel>;
}

export function UsagePage({ state, usage, records, busy, budget, setBudget, saveBudget, refresh, exportReport, savePricing, refreshOfficialPricing, openPriceSource }: {
  state: AppState; usage: UsageSummary; records: UsageRecord[]; busy: boolean; budget: string; setBudget: (value: string) => void;
  saveBudget: () => void; refresh: () => void; exportReport: () => void; savePricing: (connectionId: string, pricing: UsagePricing | null) => Promise<boolean>;
  refreshOfficialPricing: (input?: OfficialPricingRefreshInput) => Promise<OfficialPricingRefreshReport | undefined>; openPriceSource: (url: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'codex' | 'claude'>('all');
  const [pricingConnection, setPricingConnection] = useState<Connection | null>(null);
  const [priceFields, setPriceFields] = useState({ input: '', output: '', cacheRead: '', cacheWrite: '', source: '' });
  const [priceError, setPriceError] = useState('');
  const [officialConnection, setOfficialConnection] = useState<Connection | null>(null);
  const [priceUpdating, setPriceUpdating] = useState(false);
  const [priceReport, setPriceReport] = useState<OfficialPricingRefreshReport | null>(null);
  const [priceUpdateError, setPriceUpdateError] = useState('');
  const priceUpdateLock = useRef(false);
  const modalReturnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!pricingConnection && !officialConnection) return;
    const previousFocus = modalReturnFocus.current || document.activeElement;
    const dialog = document.querySelector<HTMLElement>('.pricing-modal');
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', listener);
    return () => { document.removeEventListener('keydown', listener); if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, [pricingConnection, officialConnection]);
  const shown = records.filter(record => filter === 'all' || record.engine === filter);
  const editPricing = (connection: Connection) => {
    modalReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPricingConnection(connection); setPriceError('');
    setPriceFields({ input: String(connection.pricing?.inputPerMillion ?? ''), output: String(connection.pricing?.outputPerMillion ?? ''), cacheRead: String(connection.pricing?.cacheReadPerMillion ?? ''), cacheWrite: String(connection.pricing?.cacheWritePerMillion ?? ''), source: connection.pricing?.source || '' });
  };
  const confirmOfficialPricing = (connection: Connection) => {
    modalReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOfficialConnection(connection); setPriceUpdateError('');
  };
  const applyPricing = async () => {
    if (!pricingConnection) return;
    if (!priceFields.input.trim() || !priceFields.output.trim() || [priceFields.input, priceFields.output, priceFields.cacheRead, priceFields.cacheWrite].some(value => value.trim() && (!Number.isFinite(Number(value)) || Number(value) < 0))) return setPriceError('请填写有效的非负单价，输入和输出价格不能为空。');
    const pricing: UsagePricing = { currency: 'CNY', inputPerMillion: Number(priceFields.input), outputPerMillion: Number(priceFields.output), ...(priceFields.cacheRead.trim() ? { cacheReadPerMillion: Number(priceFields.cacheRead) } : {}), ...(priceFields.cacheWrite.trim() ? { cacheWritePerMillion: Number(priceFields.cacheWrite) } : {}), source: priceFields.source.trim() || '用户填写', updatedAt: new Date().toISOString(), origin: 'manual', sourceKind: 'manual' };
    if (await savePricing(pricingConnection.id, pricing)) setPricingConnection(null);
  };
  const updatePrices = async (connection?: Connection) => {
    if (priceUpdateLock.current) return;
    priceUpdateLock.current = true;
    setPriceUpdating(true); setPriceUpdateError('');
    try {
      const result = await refreshOfficialPricing(connection ? { connectionIds: [connection.id], forceManual: true } : undefined);
      if (result) { setPriceReport(result); setOfficialConnection(null); }
      else setPriceUpdateError('未能更新官方价格，现有单价已保留。请稍后重试。');
    } catch (error) { setPriceUpdateError(error instanceof Error ? error.message : '未能更新官方价格，现有单价已保留。'); }
    finally { priceUpdateLock.current = false; setPriceUpdating(false); }
  };
  const progress = state.settings.monthlyBudgetCNY > 0 ? Math.min(usage.month.knownCostCNY / state.settings.monthlyBudgetCNY * 100, 100) : 0;
  return <>
    <div className="page-heading"><div><h1>用量与费用</h1><p>查看本机 API 用量，了解今天和这个月花了多少。</p></div><div className="button-row"><Button icon="refresh" disabled={busy} onClick={refresh}>刷新</Button><Button icon="download" disabled={busy} onClick={exportReport}>导出 CSV</Button></div></div>
    <UsageCards usage={usage} />
    {usage.warning && <Notice title="用量记录需要检查" tone="warning">{usage.warning}</Notice>}
    <div className="accounting-note"><Icon name="info" /><span>仅统计经过续航台网关的请求及本软件连接测试，按北京时间归档。费用按 Token 与连接单价估算，供应商账单可能含缓存、优惠和其他计费规则。</span></div>
    <div className="usage-grid"><UsageTrend usage={usage} /><Panel title="本月连接分布" icon="plug" actions={<span className="panel-caption">{usage.byConnection.length} 个连接</span>}><div className="distribution-list">{usage.byConnection.length ? usage.byConnection.map(item => <div className="distribution-row" key={item.connectionId}><div className={`provider-avatar ${item.engine}`}><Icon name={item.engine === 'codex' ? 'spark' : 'terminal'} /></div><div className="distribution-info"><strong>{item.name}</strong><span>{item.model} · {number(item.requestCount)} 次</span></div><strong className="tabular">{money(item.costCNY, item.knownCostCNY)}</strong></div>) : <Empty icon="plug" title="还没有连接用量" description="首次 API 请求完成后按连接归集。" />}</div></Panel></div>
    <div className="budget-inline"><div><strong>本月提醒目标</strong><span>{money(usage.month.costCNY, usage.month.knownCostCNY)} / ¥{number(state.settings.monthlyBudgetCNY)}</span></div><div className="budget-progress"><i style={{ width: `${progress}%` }} /></div><div className="budget-edit"><input aria-label="本月提醒目标人民币" type="number" min="0" step="10" value={budget} onChange={event => setBudget(event.target.value)} /><span>元</span><Button disabled={busy || !Number.isFinite(Number(budget)) || Number(budget) < 0} onClick={saveBudget}>保存</Button></div><small>仅供提醒，不自动停止调用</small></div>
    <Panel title="连接单价" icon="wallet" className="pricing-panel" actions={<div className="pricing-actions"><span className="panel-caption">元 / 百万 Token</span><Button icon="refresh" tone="soft" disabled={busy || priceUpdating || !state.connections.length} aria-busy={priceUpdating} onClick={() => void updatePrices()}>{priceUpdating ? '正在更新…' : '更新官方价格'}</Button></div>}>
      <div className="pricing-help">支持的按量模型已内置公开价格，可联网核对最新报价。手动单价会保留；“—”表示尚无可靠价格。</div>
      {priceUpdateError && <div className="price-update-error" role="alert"><Icon name="info" /><span>{priceUpdateError}</span></div>}
      {priceReport && <div className="price-update-report" aria-live="polite">
        <div className="price-report-heading"><strong>价格更新结果</strong><span>{quoteTime(priceReport.updatedAt)} · 已更新 {priceReport.updatedCount} · 手动保留 {priceReport.manualSkippedCount} · 未支持 {priceReport.unsupportedCount} · 失败 {priceReport.failedCount}</span><Button tone="ghost" icon="close" aria-label="收起价格更新结果" onClick={() => setPriceReport(null)} /></div>
        <ul>{priceReport.results.map(result => <li key={result.connectionId}><Pill tone={result.status === 'failed' ? 'error' : result.status === 'updated' || result.status === 'unchanged' ? 'success' : ''}>{PRICE_RESULT_LABELS[result.status]}</Pill><strong>{state.connections.find(connection => connection.id === result.connectionId)?.name || '连接已移除'}</strong><span>{result.message}</span></li>)}</ul>
        {!!priceReport.warnings.length && <p className="price-report-warning">{priceReport.warnings.join('；')}</p>}
      </div>}
      <div className="table-wrap"><table className="pricing-table"><thead><tr><th>连接 / 模型</th><th>输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>价格来源 / 时间</th><th>操作</th></tr></thead><tbody>{state.connections.map(connection => {
        const pricing = connection.pricing;
        const manual = manualPricing(connection);
        const time = quoteTime(pricing?.verifiedAt || pricing?.updatedAt);
        return <tr key={connection.id} data-connection-id={connection.id}>
          <td><strong>{connection.name}</strong><small>{connection.model}</small></td>
          <td className="tabular">{pricing ? `¥${pricing.inputPerMillion}` : '—'}</td><td className="tabular">{pricing ? `¥${pricing.outputPerMillion}` : '—'}</td><td className="tabular">{pricing?.cacheReadPerMillion !== undefined ? `¥${pricing.cacheReadPerMillion}` : '—'}</td><td className="tabular">{pricing?.cacheWritePerMillion !== undefined ? `¥${pricing.cacheWritePerMillion}` : '—'}</td>
          <td className="price-provenance"><div className="price-source-top"><span className={`price-mode ${manual ? 'manual' : ''}`}>{manual ? '手动' : pricing?.sourceKind === 'network' ? '官方 · 联网' : pricing?.sourceKind === 'builtin' ? '官方 · 内置' : '未定价'}</span>{pricing?.sourceUrl && <button className="price-source-link" onClick={() => openPriceSource(pricing.sourceUrl!)} title={pricing.sourceUrl}>查看来源<Icon name="external" /></button>}</div><small>{pricing?.source || (manual ? '已停止自动跟随官方价' : '暂未匹配可靠报价')}</small>{time && <small>{pricing?.verifiedAt ? '核对' : '设置'}于 {time}</small>}{pricing?.contextMaxTokens && <small>适用于单次输入 ≤ {number(pricing.contextMaxTokens)} Token</small>}{pricing?.note && <small className="price-quote-note">{pricing.note}</small>}</td>
          <td><div className="price-row-actions"><Button tone="ghost" icon="settings" disabled={busy || priceUpdating} onClick={() => editPricing(connection)}>手动设置</Button>{(manual || !pricing) && <Button tone="ghost" disabled={busy || priceUpdating} onClick={() => confirmOfficialPricing(connection)}>使用官方报价</Button>}</div></td>
        </tr>;
      })}</tbody></table>{!state.connections.length && <Empty icon="wallet" title="先添加一个 API 连接" description="支持的按量模型会自动填入公开单价，也可设置你的实际成交价格。" />}</div>
      <div className="pricing-footnote">价格更新影响后续请求，历史费用保留调用时的单价；费用估算不等于供应商实时账单。</div>
    </Panel>
    <Panel title="最近请求" icon="clock" className="records-panel" actions={<div className="filter-tabs">{(['all', 'codex', 'claude'] as const).map(item => <button className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)} key={item}>{item === 'all' ? '全部' : item === 'codex' ? 'Codex' : 'Claude'}</button>)}</div>}><div className="table-wrap"><table><thead><tr><th>时间</th><th>连接 / 模型</th><th>状态</th><th>输入 / 输出</th><th>费用</th></tr></thead><tbody>{shown.map(record => <tr key={record.id}><td className="tabular muted">{requestTime(record.finishedAt)}</td><td><strong>{record.connectionName}</strong><small>{record.model}{record.surface === 'desktop' ? ' · 桌面 Code' : record.surface === 'cli' ? ' · Code 终端' : ''}{record.kind === 'connection-test' ? ' · 连接测试' : ''}</small></td><td><Pill tone={record.outcome === 'success' ? 'success' : record.outcome === 'error' ? 'error' : 'warning'}>{record.outcome === 'success' ? '成功' : record.outcome === 'error' ? `失败 ${record.httpStatus}` : '已取消'}</Pill></td><td className="tabular">{record.tokens ? `${number(record.tokens.inputTokens)} / ${number(record.tokens.outputTokens)}` : '未返回用量'}</td><td className="tabular">{money(record.costCNY)}</td></tr>)}</tbody></table>{!shown.length && <Empty icon="clock" title="暂无请求记录" description="记录只保存时间、模型、Token 和费用，不包含对话内容或密钥。" />}</div></Panel>
    {pricingConnection && <div className="modal-layer" onKeyDown={event => { if (event.key === 'Escape' && !busy) setPricingConnection(null); }}>
      <div className="drawer-backdrop" onClick={() => { if (!busy) setPricingConnection(null); }} />
      <section className="pricing-modal" role="dialog" aria-modal="true" aria-label="设置连接单价">
        <div className="drawer-heading"><div><h2>手动设置人民币单价</h2><p>{pricingConnection.name} · {pricingConnection.model}</p></div><Button tone="ghost" icon="close" disabled={busy} aria-label="关闭单价设置" onClick={() => setPricingConnection(null)} /></div>
        <div className="drawer-content">
          <Notice title="保存后保留你的手动价格" tone="neutral">单位是元 / 百万 Token。联网更新不会覆盖手动设置；包月套餐不能由 Token 准确换算，可清除价格。</Notice>
          <div className="form-grid"><Field label="输入单价"><input autoFocus type="number" min="0" step="any" value={priceFields.input} onChange={event => setPriceFields({ ...priceFields, input: event.target.value })} /></Field><Field label="输出单价"><input type="number" min="0" step="any" value={priceFields.output} onChange={event => setPriceFields({ ...priceFields, output: event.target.value })} /></Field><Field label="缓存读取（可选）"><input type="number" min="0" step="any" value={priceFields.cacheRead} onChange={event => setPriceFields({ ...priceFields, cacheRead: event.target.value })} /></Field><Field label="缓存写入（可选）"><input type="number" min="0" step="any" value={priceFields.cacheWrite} onChange={event => setPriceFields({ ...priceFields, cacheWrite: event.target.value })} /></Field><Field label="价格来源 / 备注" full><input value={priceFields.source} onChange={event => setPriceFields({ ...priceFields, source: event.target.value })} placeholder="例如：账号折扣价或自定义说明" /></Field></div>
          {priceError && <div className="inline-error" role="alert">{priceError}</div>}
          <div className="button-row"><Button tone="primary" icon="save" disabled={busy} onClick={() => void applyPricing()}>保存单价</Button>{pricingConnection.pricing && <Button disabled={busy} onClick={() => { void savePricing(pricingConnection.id, null).then(ok => { if (ok) setPricingConnection(null); }); }}>清除价格</Button>}</div>
          <p className="helper-text">已记录的请求保留调用当时的价格。之后可点击“使用官方报价”恢复官方价格。</p>
        </div>
      </section>
    </div>}
    {officialConnection && <div className="modal-layer" onKeyDown={event => { if (event.key === 'Escape' && !priceUpdating) setOfficialConnection(null); }}>
      <div className="drawer-backdrop" onClick={() => { if (!priceUpdating) setOfficialConnection(null); }} />
      <section className="pricing-modal official-price-modal" role="dialog" aria-modal="true" aria-label="使用官方报价">
        <div className="drawer-heading"><div><h2>使用官方报价</h2><p>{officialConnection.name} · {officialConnection.model}</p></div><Button tone="ghost" icon="close" disabled={priceUpdating} aria-label="关闭官方报价确认" onClick={() => setOfficialConnection(null)} /></div>
        <div className="drawer-content"><p className="official-price-confirm-copy">将联网查询这个模型的公开报价，成功后替换当前单价，并允许后续“更新官方价格”同步。查询失败时保留现有价格。</p><p className="helper-text">账号折扣可能与公开报价不同，历史费用不会重新计算。</p>{priceUpdateError && <div className="inline-error" role="alert">{priceUpdateError}</div>}<div className="button-row"><Button disabled={priceUpdating} autoFocus onClick={() => setOfficialConnection(null)}>取消</Button><Button tone="primary" icon="refresh" disabled={busy || priceUpdating} onClick={() => void updatePrices(officialConnection)}>{priceUpdating ? '正在查询…' : '确认使用官方报价'}</Button></div></div>
      </section>
    </div>}
  </>;
}
