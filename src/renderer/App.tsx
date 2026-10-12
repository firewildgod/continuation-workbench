import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, ClaudeGuiConfigPreview, ClaudeGuiConfigResult, ConfigPreview, ConfigResult, Connection, ConnectionInput, Engine, OfficialPricingRefreshInput, OfficialPricingRefreshReport, ProviderPreset, TestResult, ToolConfigInput, UsagePricing, UsageRecord, UsageSummary } from '../shared/types';
import { Icon } from './Icon';
import { Button, Empty, Field, Notice, Panel, Pill } from './components';
import { emptyUsage, UsageCards, UsagePage, UsageTrend } from './Usage';
import { ClaudeDesktopCard } from './ClaudeDesktopCard';

type Page = 'tools' | 'usage' | 'api' | 'backup';
type ToolChoice = { mode: 'subscription' | 'api'; connectionId: string };
const PAGE_NAMES: Record<Page, string> = { tools: '工作台', usage: '用量与费用', api: 'API 连接', backup: '备份与设置' };
const ENGINE_NAMES: Record<Engine, string> = { codex: 'Codex', claude: 'Claude Code' };
const EMPTY_STATE: AppState = { projects: [], connections: [], presets: [], diagnostics: [], sessions: [], checkpoints: [], dataDir: '', settings: { monthlyBudgetCNY: 100, codexPath: '', claudePath: '', autoFallback: false } };
const TEST_NAMES = { untested: '未测试', 'auth-ok': '认证通过', passed: '连接可用', failed: '连接失败' };
const freshDraft = (engine: Engine = 'codex'): ConnectionInput => ({ name: '', presetId: 'custom', engine, baseUrl: '', model: '', protocol: engine === 'codex' ? 'responses' : 'anthropic', apiKey: '' });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
const requiredProtocol = (engine: Engine) => engine === 'codex' ? 'responses' : 'anthropic';

export default function App() {
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [page, setPage] = useState<Page>('tools');
  const [usage, setUsage] = useState<UsageSummary>(emptyUsage);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | Engine>('all');
  const [choices, setChoices] = useState<Record<Engine, ToolChoice>>({ codex: { mode: 'subscription', connectionId: '' }, claude: { mode: 'subscription', connectionId: '' } });
  const [desktopChoice, setDesktopChoice] = useState<ToolChoice>({ mode: 'subscription', connectionId: '' });
  const [draft, setDraft] = useState<ConnectionInput>(freshDraft());
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [budget, setBudget] = useState('100');
  const [backupResult, setBackupResult] = useState<{ path: string; message: string } | null>(null);
  const [vscodeResult, setVSCodeResult] = useState<{ path: string; message: string } | null>(null);
  const [configPreview, setConfigPreview] = useState<ConfigPreview | ClaudeGuiConfigPreview | null>(null);
  const [previewSurface, setPreviewSurface] = useState<'cli' | 'desktop'>('cli');
  const [previewInput, setPreviewInput] = useState<ToolConfigInput | null>(null);
  const [lastResults, setLastResults] = useState<Partial<Record<Engine, ConfigResult>>>({});
  const [desktopResult, setDesktopResult] = useState<ClaudeGuiConfigResult | null>(null);
  const [pathsOpen, setPathsOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState({ codexDesktopPath: '', codexConfigPath: '', claudePath: '', claudeConfigPath: '', claudeLaunchDirectory: '', claudeDesktopPath: '', claudeDesktopConfigDir: '' });
  const initialized = useRef(false);
  const desktopInitialized = useRef(false);
  const eventTimer = useRef<number | null>(null);
  const drawerReturnFocus = useRef<HTMLElement | null>(null);
  const preview = !window.desktop;
  const tell = useCallback((message: string, error = false) => setToast({ message, error }), []);
  const refresh = useCallback(async () => {
    if (!window.desktop) return;
    const [nextState, nextUsage, nextRecords] = await Promise.all([window.desktop.getState(), window.desktop.getUsageSummary(), window.desktop.getUsageRecords({ limit: 100 })]);
    setState(nextState); setUsage(nextUsage); setRecords(nextRecords);
  }, []);
  useEffect(() => { void refresh().catch((error: unknown) => tell(errorMessage(error), true)); }, [refresh, tell]);
  useEffect(() => {
    if (!window.desktop) return;
    const unsubscribe = window.desktop.onEvent(() => {
      if (eventTimer.current !== null) return;
      eventTimer.current = window.setTimeout(() => { eventTimer.current = null; void refresh().catch(() => {}); }, 1000);
    });
    const poll = window.setInterval(() => { void refresh().catch(() => {}); }, 10000);
    return () => { unsubscribe(); window.clearInterval(poll); if (eventTimer.current !== null) window.clearTimeout(eventTimer.current); };
  }, [refresh]);
  useEffect(() => { setBudget(String(state.settings.monthlyBudgetCNY)); }, [state.settings.monthlyBudgetCNY]);
  useEffect(() => {
    if (initialized.current || !state.companion) return;
    initialized.current = true;
    setChoices((current) => {
      const next = { ...current };
      for (const tool of state.companion!.tools) next[tool.engine] = { mode: tool.mode === 'api' ? 'api' : 'subscription', connectionId: tool.activeConnectionId || state.companion!.gateway.routes[tool.engine] || '' };
      return next;
    });
  }, [state.companion]);
  useEffect(() => {
    const desktop = state.companion?.claudeDesktop;
    if (desktopInitialized.current || !desktop) return;
    desktopInitialized.current = true;
    setDesktopChoice({ mode: desktop.mode === 'api' ? 'api' : 'subscription', connectionId: desktop.activeConnectionId || state.companion?.gateway.routes.claudeDesktop || '' });
  }, [state.companion]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), toast.error ? 8500 : 4500); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!pathsOpen && !configPreview) return;
    const previousFocus = drawerReturnFocus.current || document.activeElement;
    const dialog = document.querySelector<HTMLElement>('.drawer');
    const timer = window.setTimeout(() => dialog?.querySelector<HTMLElement>('button, input, select, textarea')?.focus(), 0);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setPathsOpen(false); setConfigPreview(null); setPreviewInput(null); }
      if (event.key !== 'Tab' || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary'));
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { window.clearTimeout(timer); document.removeEventListener('keydown', handleKey); if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, [pathsOpen, configPreview]);

  const run = async <T,>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
    if (preview) { tell('当前为网页界面预览，请运行桌面版以管理本机配置。', true); return; }
    setBusy(name);
    try { const result = await action(); await refresh(); return result; }
    catch (error) { tell(errorMessage(error), true); return; }
    finally { setBusy(''); }
  };
  const savedDraft = state.connections.find((item) => item.id === draft.id);
  const draftNeedsTest = !!savedDraft && (!!draft.apiKey?.trim() || draft.engine !== savedDraft.engine || draft.protocol !== savedDraft.protocol || draft.baseUrl !== savedDraft.baseUrl || draft.model !== savedDraft.model || draft.presetId !== savedDraft.presetId);
  useEffect(() => { setTestResult(null); }, [draft.engine, draft.protocol, draft.baseUrl, draft.model, draft.presetId, draft.apiKey]);
  const preset = state.presets.find((item) => item.id === draft.presetId);
  const gateway = state.companion?.gateway;
  const claudeDesktop = state.companion?.claudeDesktop;
  const desktopPreview = configPreview && 'surface' in configPreview ? configPreview : undefined;
  const filteredConnections = state.connections.filter(item => (filter === 'all' || item.engine === filter) && `${item.name} ${item.model}`.toLowerCase().includes(search.toLowerCase()));
  const endpointMismatch = draft.engine === 'claude' && /dashscope.*\/compatible-mode/i.test(draft.baseUrl);
  const editConnection = (item?: Connection, engine: Engine = 'codex') => {
    setDraft(item ? { id: item.id, name: item.name, presetId: item.presetId, engine: item.engine, baseUrl: item.baseUrl, model: item.model, protocol: item.protocol, apiKey: '' } : freshDraft(engine));
    setTestResult(null);
  };
  const usePreset = (selected: ProviderPreset, clean = false) => {
    const current = clean ? freshDraft(draft.engine) : draft;
    const protocol = requiredProtocol(current.engine);
    setDraft({ ...current, presetId: selected.id, name: current.id ? current.name : `${selected.name} · ${ENGINE_NAMES[current.engine]}`, protocol, baseUrl: selected.baseUrls[protocol] || '', model: selected.models.includes(current.model) ? current.model : selected.models[0] || '' });
    setTestResult(null);
  };
  const changeEngine = (engine: Engine) => {
    const protocol = requiredProtocol(engine);
    const inferredPreset = preset || (/dashscope\.aliyuncs\.com/i.test(draft.baseUrl) ? state.presets.find(item => item.id === 'bailian-payg') : undefined);
    setDraft({ ...draft, engine, protocol, ...(inferredPreset ? { presetId: inferredPreset.id, baseUrl: inferredPreset.baseUrls[protocol] || '' } : { baseUrl: draft.baseUrl }) });
    setTestResult(null);
  };
  const saveConnection = async (test = false) => {
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) return tell('请填写连接名称、服务地址和模型。', true);
    if (!savedDraft?.hasKey && !draft.apiKey?.trim()) return tell('请填写供应商提供的 API Key。', true);
    if (endpointMismatch) return tell('Claude Code 需要百炼 Anthropic 地址，请先修正接口地址。', true);
    if ((draft.engine === 'codex' && draft.protocol !== 'responses') || (draft.engine === 'claude' && draft.protocol !== 'anthropic')) return tell(`${ENGINE_NAMES[draft.engine]} 需要 ${draft.engine === 'codex' ? 'Responses' : 'Anthropic Messages'} 接口，请使用厂商文档提供的对应地址。`, true);
    await run(test ? 'test' : 'save', async () => {
      const saved = await window.desktop.saveConnection({ ...draft, apiKey: draft.apiKey?.trim() || undefined });
      setDraft((current) => ({ ...current, id: saved.id, apiKey: '' }));
      if (test) { const result = await window.desktop.testConnection(saved.id); setTestResult(result); tell(result.message, !result.ok); }
      else tell('API 连接已保存。');
    });
  };
  const external = (url: string) => void run('external', () => window.desktop.openExternal(url));
  const setChoice = (engine: Engine, change: Partial<ToolChoice>) => {
    setChoices((current) => ({ ...current, [engine]: { ...current[engine], ...change } }));
    if (engine === 'claude') setVSCodeResult(null);
  };
  const selectExecutable = (engine: Engine) => void run('executable', async () => {
    const path = await window.desktop.chooseExecutable();
    if (!path) return;
    await window.desktop.saveSettings(engine === 'codex' ? { codexDesktopPath: path } : { claudePath: path });
    await window.desktop.diagnose(); tell('工具路径已更新。');
  });
  const configInput = (engine: Engine): ToolConfigInput => ({ engine, mode: choices[engine].mode, connectionId: choices[engine].mode === 'api' ? choices[engine].connectionId || undefined : undefined });
  const previewConfig = async (engine: Engine) => {
    const input = configInput(engine);
    if (input.mode === 'api' && !input.connectionId) return tell('请先选择要接入的 API 连接。', true);
    drawerReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await run('preview-config', async () => { const result = await window.desktop.previewToolConfig(input); setPreviewSurface('cli'); setPreviewInput(input); setConfigPreview(result); });
  };
  const previewDesktopConfig = async () => {
    const input = { mode: desktopChoice.mode, connectionId: desktopChoice.mode === 'api' ? desktopChoice.connectionId || undefined : undefined };
    if (input.mode === 'api' && !input.connectionId) return tell('请先选择 Claude 桌面的 API 连接。', true);
    const issue = input.connectionId && claudeDesktop?.connectionIssues?.[input.connectionId];
    if (input.mode === 'api' && issue) return tell(issue, true);
    drawerReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await run('preview-desktop', async () => { const result = await window.desktop.previewClaudeDesktopConfig(input); setPreviewSurface('desktop'); setPreviewInput({ engine: 'claude', ...input }); setConfigPreview(result); });
  };
  const applyConfig = async () => {
    if (!previewInput) return;
    await run('apply-config', async () => {
      if (previewSurface === 'desktop') {
        const result = await window.desktop.applyClaudeDesktopConfig({ mode: previewInput.mode, connectionId: previewInput.connectionId });
        setDesktopResult(result); setConfigPreview(null); setPreviewInput(null); tell(result.message, !result.ok); return;
      }
      const result = await window.desktop.applyToolConfig(previewInput);
      setLastResults((current) => ({ ...current, [previewInput.engine]: result }));
      setConfigPreview(null); setPreviewInput(null); tell(result.message, !result.ok);
    });
  };
  const launch = (engine: Engine) => void run('launch', async () => {
    const result = await window.desktop.launchTool({ engine, directory: engine === 'claude' ? state.settings.claudeLaunchDirectory : undefined });
    setLastResults((current) => ({ ...current, [engine]: result })); tell(result.message, !result.ok);
  });
  const rollback = (id: string, engine: Engine) => void run('rollback', async () => {
    const result = await window.desktop.restoreConfigBackup(id);
    setLastResults((current) => ({ ...current, [engine]: result })); tell(result.message, !result.ok);
  });
  const openPaths = () => {
    drawerReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPathDraft({ codexDesktopPath: state.settings.codexDesktopPath || '', codexConfigPath: state.settings.codexConfigPath || '', claudePath: state.settings.claudePath || '', claudeConfigPath: state.settings.claudeConfigPath || '', claudeLaunchDirectory: state.settings.claudeLaunchDirectory || '', claudeDesktopPath: state.settings.claudeDesktopPath || '', claudeDesktopConfigDir: state.settings.claudeDesktopConfigDir || '' });
    setPathsOpen(true);
  };
  const choosePath = (key: 'codexDesktopPath' | 'claudePath' | 'claudeLaunchDirectory' | 'claudeDesktopPath' | 'claudeDesktopConfigDir') => void run('select-path', async () => {
    const path = key === 'claudeLaunchDirectory' || key === 'claudeDesktopConfigDir' ? await window.desktop.chooseFolder() : await window.desktop.chooseExecutable();
    if (path) setPathDraft((current) => ({ ...current, [key]: path }));
  });
  const launchDesktop = () => void run('launch-desktop', async () => {
    const result = await window.desktop.launchClaudeDesktop(); setDesktopResult(result); tell(result.message, !result.ok);
  });
  const restoreDesktop = (id: string) => void run('restore-desktop', async () => {
    const result = await window.desktop.restoreClaudeDesktopConfigBackup(id); setDesktopResult(result); tell(result.message, !result.ok);
  });
  const chooseDesktopProgram = () => void run('desktop-executable', async () => {
    const selected = await window.desktop.chooseExecutable(); if (!selected) return;
    await window.desktop.saveSettings({ claudeDesktopPath: selected }); await window.desktop.getClaudeDesktopState(); tell('Claude 桌面程序路径已更新。');
  });
  const saveBudget = () => void run('budget', async () => { await window.desktop.saveSettings({ monthlyBudgetCNY: Number(budget) }); tell('本月提醒目标已保存。'); });
  const savePricing = async (connectionId: string, pricing: UsagePricing | null) => {
    const result = await run('pricing', () => window.desktop.savePricing({ connectionId, pricing }));
    if (result) { tell('连接单价已更新，新请求将使用这个价格。'); return true; } return false;
  };
  const refreshOfficialPricing = async (input?: OfficialPricingRefreshInput): Promise<OfficialPricingRefreshReport | undefined> => run('official-pricing', () => window.desktop.refreshOfficialPricing(input));

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><img src={new URL('../../assets/app-icon.svg', import.meta.url).href} alt="" /></div><div><div className="brand-name">续航台</div><div className="brand-caption">本地 API 连接管理</div></div></div>
      <nav className="nav-list" aria-label="主导航">{(['tools', 'usage', 'api', 'backup'] as Page[]).map(item => <button key={item} className={`nav-item ${page === item ? 'active' : ''}`} aria-label={PAGE_NAMES[item]} title={PAGE_NAMES[item]} aria-current={page === item ? 'page' : undefined} onClick={() => setPage(item)}><Icon name={item === 'tools' ? 'work' : item === 'usage' ? 'chart' : item === 'api' ? 'plug' : 'restore'} /><span className="nav-label">{PAGE_NAMES[item]}</span>{item === 'api' && <span className="nav-count">{state.connections.length}</span>}</button>)}</nav>
      <div className="sidebar-section-label">打开工具</div>
      <button className="tool-launch" disabled={!!busy} title="打开或切回 Claude 桌面" aria-label="打开或切回 Claude 桌面" onClick={launchDesktop}><Icon name="desktop" /><span>Claude 桌面</span><Icon name="external" /></button>
      {(['codex', 'claude'] as Engine[]).map(engine => <button key={engine} className="tool-launch" disabled={!!busy} title={engine === 'codex' ? '打开或切回 Codex' : '打开 Claude Code 终端'} onClick={() => launch(engine)}><Icon name={engine === 'codex' ? 'spark' : 'terminal'} /><span>{ENGINE_NAMES[engine]}</span><Icon name="external" /></button>)}
      <div className="sidebar-bottom"><div className="sidebar-gateway"><span className={`runtime-dot ${gateway?.running ? 'available' : ''}`} /><span>{gateway?.running ? '本机网关运行中' : '本机网关未启动'}</span></div><p className="sidebar-hint">外部 API 使用期间<br />请保持续航台运行</p><div className="version"><span>Windows 便携版</span><span>v0.2.2</span></div></div>
    </aside>
    <main className="main-pane">
      <header className="topbar"><div className="breadcrumb"><span>续航台</span><Icon name="chevron" /><strong>{PAGE_NAMES[page]}</strong></div><div className="topbar-actions">{preview && <span className="preview-badge">界面预览</span>}<Button icon="refresh" tone="ghost" disabled={!!busy} onClick={() => void run('diagnose', async () => { await window.desktop.getToolState(); await window.desktop.diagnose(); tell('状态已刷新。'); })}>刷新状态</Button><Button icon="settings" tone="ghost" aria-label="工具路径设置" onClick={openPaths}>工具设置</Button></div></header>
      <div className="page">
        {preview && <div className="preview-banner"><Icon name="info" />网页预览不读取本机数据。请打开桌面版查看实际连接和费用。</div>}
        {page === 'tools' && <>
          <div className="page-heading"><div><h1>工作台</h1><p>为 Codex、Claude 桌面和终端分别选择连接，回到原工具继续工作。</p></div><Button icon="plus" tone="primary" onClick={() => { editConnection(); setPage('api'); }}>添加连接</Button></div>
          <UsageCards usage={usage} onDetails={() => setPage('usage')} />
          {usage.warning && <Notice title="用量记录需要检查" tone="warning">{usage.warning}</Notice>}
          <div className="section-heading"><h2>工具连接</h2><span>应用配置前会自动保存备份</span></div>
          <div className="connector-grid">{(['codex', 'claude-desktop', 'claude'] as const).map(surface => {
            if (surface === 'claude-desktop') return <ClaudeDesktopCard key={surface} status={claudeDesktop} choice={desktopChoice} connections={state.connections} gateway={gateway} busy={!!busy} result={desktopResult || undefined} onChoice={change => { setDesktopChoice(current => ({ ...current, ...change })); setDesktopResult(null); }} onPreview={() => void previewDesktopConfig()} onLaunch={launchDesktop} onRestore={restoreDesktop} onAddConnection={() => { editConnection(undefined, 'claude'); setPage('api'); }} onEditConnection={connection => { editConnection(connection); setPage('api'); }} onChooseProgram={chooseDesktopProgram} onOpenFolder={() => void run('desktop-folder', () => window.desktop.openClaudeDesktopConfigFolder())} onUsage={() => setPage('usage')} onDocs={() => external('https://claude.com/docs/third-party/claude-desktop/configuration')} onUseTerminal={connection => { setChoice('claude', { mode: 'api', connectionId: connection.id }); document.querySelector('.claude-cli-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); tell('已在终端卡片选择此连接；先预览并应用，再导出 VS Code 图形扩展设置。'); }} />;
            const engine: Engine = surface;
            const tool = state.companion?.tools.find(item => item.engine === engine);
            const activeConnection = state.connections.find(item => item.id === tool?.activeConnectionId);
            const latestBackup = state.companion?.backups.filter(item => item.engine === engine && item.canRestore).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            const result = lastResults[engine]; const choice = choices[engine];
            const connections = state.connections.filter(item => item.engine === engine);
            const connection = connections.find(item => item.id === choice.connectionId);
            return <section className={`panel connector-card ${engine === 'claude' ? 'claude-cli-card' : 'codex-card'}`} key={engine}>
              <div className="connector-heading"><div className={`tool-mark ${engine}`}><Icon name={engine === 'codex' ? 'spark' : 'terminal'} /></div><div className="connector-title"><h2>{ENGINE_NAMES[engine]}</h2><span>{engine === 'codex' ? '官方桌面应用' : '终端 · CLI 配置'}</span></div><Pill tone={tool?.running ? 'success' : tool?.executablePath ? '' : 'warning'}>{tool ? tool.running ? '运行中' : tool.executablePath ? '已安装' : '未找到程序' : '未检测'}</Pill></div>
              <div className="connector-content"><div className={`current-route ${tool?.mode === 'api' ? 'api-route' : ''}`}><span className="section-label">当前配置</span><div className="route-title"><strong>{tool ? tool.mode === 'api' ? activeConnection?.name || '外部 API' : tool.mode === 'subscription' ? '官方账号 / 原配置' : '配置未确认' : '等待本机检测'}</strong><span>{tool?.mode === 'api' ? activeConnection?.model || '' : '由官方工具管理登录'}</span></div><p>{tool?.message || '打开桌面版后自动检测工具和配置。'}</p></div>
                <div className="form-grid tool-choice"><Field label="使用方式"><select value={choice.mode} onChange={event => setChoice(engine, { mode: event.target.value as ToolChoice['mode'] })}><option value="subscription">官方账号 / 原配置</option><option value="api">外部 API</option></select></Field><Field label="API 连接"><select disabled={choice.mode === 'subscription'} value={choice.connectionId} onChange={event => setChoice(engine, { connectionId: event.target.value })}><option value="">{choice.mode === 'subscription' ? '使用官方配置' : '选择一个连接'}</option>{connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></Field></div>
                {choice.mode === 'api' && !connections.length && <div className="inline-callout"><span>还没有可用的 {ENGINE_NAMES[engine]} 连接</span><Button tone="ghost" icon="plus" onClick={() => { editConnection(undefined, engine); setPage('api'); }}>添加</Button></div>}
                {choice.mode === 'api' && connection && <div className="connection-meta"><Pill tone={connection.testStatus === 'passed' ? 'success' : connection.testStatus === 'failed' ? 'error' : ''}>{TEST_NAMES[connection.testStatus || 'untested']}</Pill><code>{connection.protocol === 'responses' ? 'Responses' : 'Anthropic Messages'}</code>{connection.testStatus === 'failed' && <button className="text-button" onClick={() => { editConnection(connection); setPage('api'); }}>修复连接</button>}</div>}
                {engine === 'claude' && choice.mode === 'api' && connection && <div className="vscode-guidance"><Button icon="desktop" tone="soft" disabled={!!busy || !connection.hasKey || tool?.mode !== 'api' || gateway?.routes.claude !== connection.id} onClick={() => void run('vscode-export', async () => { const exported = await window.desktop.exportVSCodeConfig(connection.id); setVSCodeResult(exported); tell(`VS Code 配置已导出：${exported.path}`); })}>导出 VS Code 图形配置</Button><p className="helper-text">{tool?.mode === 'api' && gateway?.routes.claude === connection.id ? '导入到官方 Claude Code 扩展设置，重启 VS Code 后新建会话。' : '先在此卡片预览并应用连接，再导出官方 Claude Code 扩展的设置。'}</p>{vscodeResult && <p className="helper-text">{vscodeResult.message}<br />{vscodeResult.path}</p>}</div>}<div className="connector-actions"><Button icon="save" tone="primary" disabled={!!busy || !tool || (choice.mode === 'api' && !connection?.hasKey)} onClick={() => void previewConfig(engine)}>预览并应用</Button><Button icon={engine === 'claude' ? 'terminal' : 'desktop'} disabled={!!busy || !tool?.executablePath} onClick={() => launch(engine)}>{engine === 'claude' ? '打开终端' : tool?.running ? '切回 Codex' : '打开 Codex'}</Button><Button icon="restore" tone="ghost" disabled={!!busy || !latestBackup} onClick={() => latestBackup && rollback(latestBackup.id, engine)}>回滚</Button></div>
                {tool?.mode === 'api' && gateway?.running && choice.mode === 'api' && connection && gateway.routes[engine] !== connection.id && <div className="inline-callout"><span>已在 API 模式，可切换后续请求的连接</span><Button icon="refresh" tone="soft" disabled={!!busy || !connection.hasKey} onClick={() => void run('route', async () => { const switched = await window.desktop.switchRoute({ engine, connectionId: connection.id }); setLastResults(current => ({ ...current, [engine]: switched })); tell(switched.message, !switched.ok); })}>切换路由</Button></div>}
                {result && <div className={`action-result ${result.ok ? '' : 'error'}`} role="status"><Icon name={result.ok ? 'check' : 'info'} /><span>{result.message}{result.restartRequired && ' 保存工作后，请退出并重新启动工具。'}</span></div>}
                <details className="tool-details"><summary>路径与接入说明<Icon name="chevron" /></summary><div className="path-row"><span>程序</span><code title={tool?.executablePath}>{tool?.executablePath || '尚未定位'}</code><Button icon="folder" tone="ghost" aria-label={`选择 ${ENGINE_NAMES[engine]} 程序`} onClick={() => selectExecutable(engine)} disabled={!!busy} /></div><div className="path-row"><span>配置</span><code title={tool?.configPath}>{tool?.configPath || '等待检测'}</code><Button icon="external" tone="ghost" aria-label={`打开 ${ENGINE_NAMES[engine]} 配置目录`} disabled={!!busy || !tool} onClick={() => void run('config-folder', () => window.desktop.openConfigFolder(engine))} /></div><p className="helper-text">官方账号与 API 模式切换后需重启工具，并新建聊天确认模型。</p>{engine === 'claude' && <><p className="helper-text">此处配置 Claude Code 终端。Claude 图形工作台请使用独立的桌面卡片；VS Code 扩展可导出设置。</p><button className="text-button" onClick={() => external('https://code.claude.com/docs/en/llm-gateway-connect#desktop-app')}>Claude 桌面接入说明<Icon name="external" /></button>{vscodeResult && <p className="helper-text">{vscodeResult.message}<br />{vscodeResult.path}</p>}</>}</details>
              </div>
            </section>;
          })}</div>
          <div className="gateway-strip"><div className="gateway-heading"><Icon name="plug" /><strong>本机网关</strong><Pill tone={gateway?.running ? 'success' : ''}>{gateway?.running ? '运行中' : '未启动'}</Pill></div><div className="gateway-meta"><code>{gateway?.baseUrl || '应用 API 配置后分配'}</code><span>进行中 <strong>{gateway?.activeRequests || 0}</strong></span><span>Codex <strong>{gateway?.requestCounts.codex || 0}</strong></span><span>Claude 桌面 <strong>{gateway?.requestCounts.claudeDesktop || 0}</strong></span><span>Claude 终端 <strong>{Math.max((gateway?.requestCounts.claude || 0) - (gateway?.requestCounts.claudeDesktop || 0), 0)}</strong></span></div>{gateway?.lastError && <div className="inline-error"><Icon name="info" />{gateway.lastError}<button className="text-button" onClick={() => setPage('api')}>检查连接</button></div>}</div>
          <div className="overview-bottom"><UsageTrend usage={usage} /><Panel title="开始使用" icon="arrow"><div className="getting-started"><div><span>01</span><div><strong>保存并测试连接</strong><p>选择供应商，填写密钥与模型。</p></div><button className="text-button" onClick={() => { editConnection(); setPage('api'); }}>添加连接</button></div><div><span>02</span><div><strong>预览并应用配置</strong><p>选择工具的 API 模式，应用前自动备份。</p></div></div><div><span>03</span><div><strong>回到官方工具</strong><p>重新启动并新建聊天，确认费用记录。</p></div><button className="text-button" onClick={() => setPage('usage')}>查看费用</button></div></div></Panel></div>
        </>}
        {page === 'usage' && <UsagePage state={state} usage={usage} records={records} busy={!!busy} budget={budget} setBudget={setBudget} saveBudget={saveBudget} refresh={() => void run('refresh-usage', refresh)} exportReport={() => void run('export-usage', async () => { const result = await window.desktop.exportUsageReport(); tell(result.message); })} savePricing={savePricing} refreshOfficialPricing={refreshOfficialPricing} openPriceSource={external} />}
        {page === 'api' && <>
          <div className="page-heading"><div><h1>API 连接</h1><p>连接密钥保存在本机。每个工具使用对应协议和服务地址。</p></div><Button icon="plus" tone="primary" onClick={() => editConnection()}>新增连接</Button></div>
          <div className="connections-layout"><Panel title="我的连接" icon="plug" className="connections-master" actions={<span className="panel-caption">{state.connections.length}</span>}><div className="connection-toolbar"><div className="search-input"><Icon name="search" /><input aria-label="搜索连接或模型" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索连接或模型" /></div><div className="filter-tabs">{(['all', 'codex', 'claude'] as const).map(item => <button key={item} className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>{item === 'all' ? '全部' : ENGINE_NAMES[item]}</button>)}</div></div><div className="connection-list">{filteredConnections.length ? filteredConnections.map(item => <button className={`connection-card ${draft.id === item.id ? 'active' : ''}`} key={item.id} onClick={() => editConnection(item)}><div className={`provider-avatar ${item.engine}`}><Icon name={item.engine === 'codex' ? 'spark' : 'terminal'} /></div><div className="connection-details"><strong>{item.name}</strong><small>{item.model}</small><div className="card-tags"><span>{ENGINE_NAMES[item.engine]}</span><span className={`connection-test ${item.testStatus === 'failed' ? 'failed' : item.testStatus === 'passed' ? 'passed' : ''}`}>{TEST_NAMES[item.testStatus || 'untested']}</span></div></div></button>) : <Empty icon="plug" title={state.connections.length ? '没有匹配的连接' : '添加你的第一个连接'} description={state.connections.length ? '尝试其他关键词或工具筛选。' : '在右侧选择供应商，填写密钥后保存并测试。'} />}</div></Panel>
            <Panel title={draft.id ? '编辑连接' : '新增连接'} icon="settings" className="connection-editor" actions={savedDraft && <Pill tone={savedDraft.hasKey ? 'success' : 'warning'}>{savedDraft.hasKey ? '密钥已保存' : '缺少密钥'}</Pill>}><div className="panel-body"><div className="form-grid"><Field label="使用工具"><select value={draft.engine} onChange={event => changeEngine(event.target.value as Engine)}><option value="codex">Codex</option><option value="claude">Claude（桌面 / Code 终端）</option></select></Field><Field label="供应商 / 计费方式"><select value={draft.presetId} onChange={event => { const selected = state.presets.find(item => item.id === event.target.value); if (selected) usePreset(selected); else { setDraft(current => ({ ...current, presetId: 'custom' })); setTestResult(null); } }}><option value="custom">自定义 API</option>{state.presets.filter(item => item.id !== 'custom').map(item => <option disabled={!item.protocols.includes(requiredProtocol(draft.engine))} key={item.id} value={item.id}>{item.name}{!item.protocols.includes(requiredProtocol(draft.engine)) ? '（该工具暂不支持）' : ''}</option>)}</select></Field><Field label="连接名称" full><input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="例如：百炼按量 · Codex" /></Field><Field label="API Key" full hint={savedDraft?.hasKey ? '留空保留现有密钥，填写新密钥可替换。' : '填写模型 API Key；阿里云 AccessKey ID 不能用于这里。'}><input type="password" autoComplete="new-password" value={draft.apiKey || ''} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} placeholder={savedDraft?.hasKey ? `${savedDraft.maskedKey || '密钥已保存'}（留空保留）` : '粘贴供应商的模型 API Key'} /></Field><Field label="模型 ID" full hint="选择常用模型，或直接输入账号可用的模型 ID。"><div className="model-input"><input list="model-options" value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} placeholder="选择或输入模型 ID" spellCheck={false} /><datalist id="model-options">{preset?.models.map(model => <option key={model} value={model} />)}</datalist></div></Field><Field label="服务地址（Base URL）" full hint={draft.engine === 'codex' ? '需要 Responses 接口；预设会自动匹配地址。' : '需要 Anthropic Messages 接口，不能使用 Codex 的兼容地址。'}><input value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} placeholder={draft.engine === 'codex' ? 'https://api.example.com/v1' : 'https://api.example.com/anthropic'} spellCheck={false} /></Field></div>
              <div className="protocol-row"><span>接口协议</span><Pill tone="info">{draft.protocol === 'responses' ? 'Responses · Codex' : draft.protocol === 'anthropic' ? 'Anthropic Messages · Claude Code' : 'Chat Completions · 需修正'}</Pill></div>
              {endpointMismatch && <div className="repair-notice"><Icon name="info" /><div><strong>这个地址适用于 Codex，Claude Code 会返回 404</strong><p>百炼的两种接口使用不同地址，已保存的密钥可以继续使用。</p><Button tone="soft" icon="refresh" onClick={() => { const payg = state.presets.find(item => item.id === 'bailian-payg'); if (payg) setDraft(current => ({ ...current, presetId: payg.id, baseUrl: payg.baseUrls.anthropic || '', protocol: 'anthropic' })); setTestResult(null); }}>修正接口地址</Button></div></div>}
              {preset && <div className="provider-context"><span>{preset.note || preset.description}</span><div className="vendor-links"><button onClick={() => external(preset.purchaseUrl)}>官方购买<Icon name="external" /></button><button onClick={() => external(preset.docsUrl)}>接入文档<Icon name="external" /></button></div></div>}
              <div className="form-actions"><div className="button-row"><Button tone="primary" icon="check" disabled={!!busy || endpointMismatch} onClick={() => void saveConnection(true)}>{busy === 'test' ? '正在测试…' : '保存并测试'}</Button><Button icon="save" disabled={!!busy || endpointMismatch} onClick={() => void saveConnection(false)}>保存</Button></div>{draft.id && <Button icon="trash" tone="ghost" disabled={!!busy} aria-label="删除连接" onClick={() => void run('delete', async () => { await window.desktop.deleteConnection(draft.id!); editConnection(); tell('连接已删除。'); })} />}</div><p className="helper-text">测试会发起少量真实 API 调用，可能产生费用。通过测试后再应用到工作台。</p>{draftNeedsTest && <p className="helper-text">配置已修改，请保存并重新测试。</p>}{!draftNeedsTest && (testResult || savedDraft?.testMessage) && <div className={`test-result ${(testResult?.status || savedDraft?.testStatus) === 'failed' ? 'failed' : ''}`}><div><Icon name={(testResult?.ok || savedDraft?.testStatus === 'passed') ? 'check' : 'info'} /><strong>{testResult ? TEST_NAMES[testResult.status] : TEST_NAMES[savedDraft!.testStatus || 'untested']}</strong>{testResult && <span>{testResult.elapsedMs} ms</span>}</div><p>{testResult?.message || savedDraft?.testMessage}</p>{(testResult?.status || savedDraft?.testStatus) === 'passed' && <button className="text-button" onClick={() => { setChoice(draft.engine, { mode: 'api', connectionId: draft.id! }); setPage('tools'); }}>前往工作台应用连接<Icon name="arrow" /></button>}</div>}</div></Panel>
          </div>
          <details className="provider-directory" open><summary><strong>供应商目录与购买入口</strong><span>区分按量 API 和包月套餐</span><Icon name="chevron" /></summary><div className="vendor-grid">{state.presets.filter(item => item.id !== 'custom').map(item => <div className="vendor-card" key={item.id}><div><strong>{item.name}</strong><Pill>{item.id.includes('plan') || item.id === 'bailian' || item.id === 'minimax' || item.id === 'kimi' ? '套餐 / 权益' : 'API'}</Pill></div><p>{item.description}</p><div className="vendor-links"><button disabled={!item.protocols.includes(requiredProtocol(draft.engine))} onClick={() => { usePreset(item, true); document.querySelector('.connection-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>使用预设<Icon name="plus" /></button><button onClick={() => external(item.purchaseUrl)}>官网<Icon name="external" /></button><button onClick={() => external(item.docsUrl)}>文档<Icon name="external" /></button></div></div>)}</div>{!state.presets.length && <div className="directory-empty">供应商目录在桌面版加载。</div>}</details>
        </>}
        {page === 'backup' && <>
          <div className="page-heading"><div><h1>备份与设置</h1><p>查看配置历史、恢复连接方式，或导出便携数据。</p></div><Button icon="download" tone="primary" disabled={!!busy} onClick={() => void run('backup', async () => { const result = await window.desktop.exportBackup(); setBackupResult(result); tell(result.message); })}>导出无密钥备份</Button></div>
          <div className="settings-strip"><div><Icon name="folder" /><div><strong>本地数据目录</strong><code title={state.dataDir}>{state.dataDir || '桌面版启动后显示'}</code></div></div><Button icon="settings" onClick={openPaths}>工具路径设置</Button></div>
          <Panel title="配置历史" icon="restore" actions={<span className="panel-caption">{state.companion?.backups.length || 0} 份备份</span>}><div className="table-wrap"><table><thead><tr><th>工具 / 变更</th><th>时间</th><th>配置文件</th><th /></tr></thead><tbody>{state.companion?.backups.map(item => <tr key={item.id}><td><strong>{ENGINE_NAMES[item.engine]}</strong><small>{item.label}</small></td><td className="tabular muted">{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</td><td><code className="table-path" title={item.configPath}>{item.configPath}</code></td><td><Button icon="restore" disabled={!!busy || !item.canRestore} onClick={() => rollback(item.id, item.engine)}>恢复</Button></td></tr>)}</tbody></table>{!state.companion?.backups.length && <Empty icon="restore" title="还没有配置历史" description="应用 API 配置时自动备份原文件，之后可以从这里恢复。" />}</div></Panel>
          <div className="settings-grid"><Panel title="迁移到另一台电脑" icon="folder"><div className="panel-body"><div className="info-rows"><Info label="已保存连接" value={`${state.connections.length} 个`} /><Info label="配置与连接导出" value="不包含 API 密钥" /><Info label="会员登录" value="在官方工具重新登录" /><Info label="运行环境" value="目标电脑需安装 Codex / Claude Code" /></div><p className="helper-text">本机密钥由 Windows 加密保存。拷贝数据后，另一台电脑需要重新填写密钥。</p>{backupResult && <div className="test-result"><strong>备份已导出</strong><p>{backupResult.message}</p><code>{backupResult.path}</code></div>}</div></Panel><Panel title="恢复配置" icon="shield"><div className="panel-body"><p className="plain-copy">恢复将重新写入备份时的工具配置。保存当前工作，完全退出工具后再恢复；之后重新启动并检查模型。</p><p className="helper-text">项目文件和官方会话由原工具管理。配置预览会隐藏密钥和登录凭据。</p><Button icon="work" onClick={() => setPage('tools')}>返回工作台</Button></div></Panel></div>
        </>}
      </div>
    </main>

    {pathsOpen && <><div className="drawer-backdrop" onClick={() => setPathsOpen(false)} /><aside className="drawer" role="dialog" aria-modal="true" aria-label="路径设置"><div className="drawer-heading"><div><h2>官方工具与配置路径</h2><p>留空使用默认检测。修改路径不会移动原配置。</p></div><Button icon="close" tone="ghost" aria-label="关闭路径设置" onClick={() => setPathsOpen(false)} /></div><div className="drawer-content"><Field label="Claude 桌面程序"><div className="path-input"><input value={pathDraft.claudeDesktopPath} onChange={event => setPathDraft({ ...pathDraft, claudeDesktopPath: event.target.value })} placeholder={claudeDesktop?.executablePath || '自动检测 Claude 桌面程序'} /><Button icon="folder" aria-label="选择 Claude 桌面程序" disabled={!!busy} onClick={() => choosePath('claudeDesktopPath')} /></div></Field><Field label="Claude 桌面配置目录" hint="选择 Claude-3p 下的 configLibrary 目录；桌面与终端的配置独立。"><div className="path-input"><input value={pathDraft.claudeDesktopConfigDir} onChange={event => setPathDraft({ ...pathDraft, claudeDesktopConfigDir: event.target.value })} placeholder={claudeDesktop?.configPath ? claudeDesktop.configPath.replace(/[\\/][^\\/]+$/, '') : '自动检测 Claude 桌面配置目录'} /><Button icon="folder" aria-label="选择 Claude 桌面配置目录" disabled={!!busy} onClick={() => choosePath('claudeDesktopConfigDir')} /></div></Field><div className="divider" style={{ margin: 0 }} /><Field label="Codex 桌面程序"><div className="path-input"><input value={pathDraft.codexDesktopPath} onChange={(event) => setPathDraft({ ...pathDraft, codexDesktopPath: event.target.value })} placeholder={state.companion?.tools.find((item) => item.engine === 'codex')?.executablePath || '自动检测 Codex 桌面程序'} /><Button icon="folder" aria-label="选择 Codex 桌面程序" disabled={!!busy} onClick={() => choosePath('codexDesktopPath')} /></div></Field><Field label="Codex 配置文件"><input value={pathDraft.codexConfigPath} onChange={(event) => setPathDraft({ ...pathDraft, codexConfigPath: event.target.value })} placeholder={state.companion?.tools.find((item) => item.engine === 'codex')?.configPath || '默认 .codex/config.toml'} /></Field><div className="divider" style={{ margin: 0 }} /><Field label="Claude Code 程序"><div className="path-input"><input value={pathDraft.claudePath} onChange={(event) => setPathDraft({ ...pathDraft, claudePath: event.target.value })} placeholder={state.companion?.tools.find((item) => item.engine === 'claude')?.executablePath || '自动检测 Claude Code'} /><Button icon="folder" aria-label="选择 Claude Code 程序" disabled={!!busy} onClick={() => choosePath('claudePath')} /></div></Field><Field label="Claude Code 配置文件"><input value={pathDraft.claudeConfigPath} onChange={(event) => setPathDraft({ ...pathDraft, claudeConfigPath: event.target.value })} placeholder={state.companion?.tools.find((item) => item.engine === 'claude')?.configPath || '默认 .claude/settings.json'} /></Field><Field label="Claude Code 启动目录"><div className="path-input"><input value={pathDraft.claudeLaunchDirectory} onChange={(event) => setPathDraft({ ...pathDraft, claudeLaunchDirectory: event.target.value })} placeholder="选择希望在官方终端打开的工作目录" /><Button icon="folder" aria-label="选择 Claude Code 启动目录" disabled={!!busy} onClick={() => choosePath('claudeLaunchDirectory')} /></div></Field><Button icon="save" tone="primary" disabled={!!busy} onClick={() => void run('paths', async () => { await window.desktop.saveSettings(pathDraft); await window.desktop.getToolState(); setPathsOpen(false); tell('路径设置已保存并重新检测。'); })}>保存并重新检测</Button></div></aside></>}
    {configPreview && <>
      <div className="drawer-backdrop" onClick={() => { setConfigPreview(null); setPreviewInput(null); }} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="配置预览">
        <div className="drawer-heading"><div><h2>{previewSurface === 'desktop' ? 'Claude Desktop' : ENGINE_NAMES[configPreview.engine]} 配置预览</h2><p>{previewSurface === 'desktop' && desktopPreview?.activationKind === 'manual-import' ? '先准备桌面导入配置，完成导入后再验证请求。' : `将使用${configPreview.mode === 'api' ? '外部 API' : '官方默认 / 原有配置'}模式；应用前保存原配置。`}</p></div><Button icon="close" tone="ghost" aria-label="关闭预览" disabled={!!busy} onClick={() => { setConfigPreview(null); setPreviewInput(null); }} /></div>
        <div className="drawer-content"><div className="path-row"><span>目标文件</span><code title={configPreview.configPath}>{configPreview.configPath}</code></div>{configPreview.warnings.map((warning, index) => <Notice key={index} title={warning} tone="warning" />)}
          <div><div className="section-label">{previewSurface === 'desktop' && desktopPreview?.activationKind === 'manual-import' ? '准备导入的配置' : '应用后'}</div><pre className="config-code">{configPreview.after || '配置文件将不包含 API 覆盖设置。'}</pre></div>
          <details><summary style={{ color: '#8b9ca6', fontSize: 11, cursor: 'pointer' }}>查看原配置</summary><pre className="config-code" style={{ marginTop: 12 }}>{configPreview.before || '原配置为空。'}</pre></details>
          <Button icon="save" tone="primary" disabled={!!busy || !configPreview.changed} onClick={() => void applyConfig()}>{!configPreview.changed ? '配置已匹配，无需修改' : previewSurface === 'desktop' && desktopPreview?.activationKind === 'manual-import' ? '准备导入配置' : '应用这份配置并保存备份'}</Button>
          <p className="helper-text">{previewSurface === 'desktop' ? '配置完成后，保存工作并完全退出 Claude Desktop，重新打开 Code 页的新会话。桌面请求通过本机网关后才显示“已验证”；终端配置独立保留。' : '应用配置不会结束正在运行的官方工具。默认配置与 API 模式切换后请手动重新启动。'}</p>
        </div>
      </aside>
    </>}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="status"><Icon name={toast.error ? 'info' : 'check'} /><span>{toast.message}</span><Button tone="ghost" icon="close" aria-label="关闭提示" onClick={() => setToast(null)} /></div>}
  </div>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="info-row"><span className="label">{label}</span><span className="value">{value}</span></div>; }
