import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, EngineEvent } from '../shared/types';

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`desktop:${method}`, ...args);
const methods = ['getUsageSummary','getUsageRecords','savePricing','refreshOfficialPricing','exportUsageReport','getState','getToolState','chooseFolder','chooseExecutable','saveConnection','deleteConnection','testConnection','saveSettings','diagnose','previewToolConfig','applyToolConfig','switchRoute','launchTool','restoreConfigBackup','openConfigFolder','openExternal','exportBackup','exportVSCodeConfig','getClaudeDesktopState','previewClaudeDesktopConfig','applyClaudeDesktopConfig','restoreClaudeDesktopConfigBackup','launchClaudeDesktop','openClaudeDesktopConfigFolder'] as const;
const bridge: Record<string, unknown> = {};
for (const method of methods) bridge[method] = (...args: unknown[]) => invoke(method,...args);
bridge.onEvent = (callback: (event: EngineEvent)=>void) => {
  const listener=(_event:unknown,payload:EngineEvent)=>callback(payload);
  ipcRenderer.on('engine-event',listener); return ()=>ipcRenderer.removeListener('engine-event',listener);
};
contextBridge.exposeInMainWorld('desktop', bridge as unknown as DesktopAPI);
