import { contextBridge, ipcRenderer } from 'electron'
import type {
  AccessLogEntry,
  Account,
  AiChatResult,
  AiMode,
  AiProviderId,
  AiStatus,
  ApiStatus,
  ApplyResult,
  ConsoleAnswers,
  CredentialStatus,
  DashboardData,
  Questionnaire,
  DevAccounts,
  DevAccountState,
  LockState,
  PendingEdit,
  RunResult,
  SheetIapInfo,
  SheetSummary,
  StoreKind,
  StoreSnapshotEntry
} from '../shared/launch-types'

const api = {
  platform: process.platform,
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  setLocale: (locale: 'ko' | 'en'): Promise<void> => ipcRenderer.invoke('app:setLocale', locale),
  getLocale: (): Promise<'ko' | 'en'> => ipcRenderer.invoke('app:getLocale'),
  ai: {
    status: (fresh?: boolean): Promise<AiStatus> => ipcRenderer.invoke('ai:status', fresh),
    setModel: (model: string): Promise<void> => ipcRenderer.invoke('ai:setModel', model),
    setActive: (provider: AiProviderId): Promise<void> =>
      ipcRenderer.invoke('ai:setActive', provider),
    setMode: (provider: AiProviderId, mode: AiMode): Promise<void> =>
      ipcRenderer.invoke('ai:setMode', provider, mode),
    setKey: (provider: AiProviderId, key: string): Promise<boolean> =>
      ipcRenderer.invoke('ai:setKey', provider, key),
    chat: (prompt: string, opts?: { resume?: string }): Promise<AiChatResult> =>
      ipcRenderer.invoke('ai:chat', prompt, opts)
  },
  launch: {
    listSheets: (): Promise<SheetSummary[]> => ipcRenderer.invoke('launch:listSheets'),
    checkCredentials: (file: string): Promise<CredentialStatus> =>
      ipcRenderer.invoke('launch:checkCredentials', file),
    getDevAccounts: (): Promise<DevAccounts> => ipcRenderer.invoke('launch:getDevAccounts'),
    setDevAccount: (store: StoreKind, info: DevAccountState): Promise<DevAccounts> =>
      ipcRenderer.invoke('launch:setDevAccount', store, info),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('launch:openExternal', url),
    createSheet: (
      name: string,
      packageName: string,
      bundleId: string
    ): Promise<{ ok: boolean; file?: string; error?: string }> =>
      ipcRenderer.invoke('launch:createSheet', name, packageName, bundleId),
    importApp: (
      name: string,
      packageName: string,
      saPath: string
    ): Promise<{ ok: boolean; file?: string; verified?: boolean; error?: string; detail?: string }> =>
      ipcRenderer.invoke('launch:importApp', name, packageName, saPath),
    lastSa: (): Promise<string> => ipcRenderer.invoke('launch:lastSa'),
    fetchIcon: (file: string): Promise<boolean> => ipcRenderer.invoke('launch:fetchIcon', file),
    dashboard: (file: string): Promise<DashboardData> =>
      ipcRenderer.invoke('launch:dashboard', file),
    apiStatus: (): Promise<ApiStatus> => ipcRenderer.invoke('launch:apiStatus'),
    dashboardCached: (file: string): Promise<DashboardData | null> =>
      ipcRenderer.invoke('launch:dashboardCached', file),
    snapshots: (file: string): Promise<StoreSnapshotEntry[]> =>
      ipcRenderer.invoke('launch:snapshots', file),
    questionnaire: (id: string): Promise<Questionnaire | null> =>
      ipcRenderer.invoke('launch:questionnaire', id),
    getConsoleAnswers: (file: string, id: string): Promise<ConsoleAnswers | null> =>
      ipcRenderer.invoke('launch:getConsoleAnswers', file, id),
    setConsoleAnswers: (file: string, id: string, data: ConsoleAnswers): Promise<void> =>
      ipcRenderer.invoke('launch:setConsoleAnswers', file, id, data),
    ageRatingDeclaration: (file: string): Promise<Record<string, string> | null> =>
      ipcRenderer.invoke('launch:ageRatingDeclaration', file),
    applyEdits: (file: string, edits: PendingEdit[]): Promise<ApplyResult[]> =>
      ipcRenderer.invoke('launch:applyEdits', file, edits),
    listAscApps: (): Promise<{ name: string; bundleId: string }[]> =>
      ipcRenderer.invoke('launch:listAscApps'),
    getJourney: (file: string): Promise<{ registered: boolean }> =>
      ipcRenderer.invoke('launch:getJourney', file),
    setJourney: (file: string, registered: boolean): Promise<{ registered: boolean }> =>
      ipcRenderer.invoke('launch:setJourney', file, registered),
    sheetIap: (file: string): Promise<SheetIapInfo> => ipcRenderer.invoke('launch:sheetIap', file),
    runIap: (file: string, action: 'upsert' | 'activate'): Promise<RunResult> =>
      ipcRenderer.invoke('launch:runIap', file, action)
  },
  accounts: {
    list: (): Promise<Account[]> => ipcRenderer.invoke('accounts:list'),
    add: (email: string, memo: string, apps: string[]): Promise<Account[]> =>
      ipcRenderer.invoke('accounts:add', email, memo, apps),
    setApps: (id: string, apps: string[]): Promise<Account[]> =>
      ipcRenderer.invoke('accounts:setApps', id, apps),
    setMemo: (id: string, memo: string): Promise<Account[]> =>
      ipcRenderer.invoke('accounts:setMemo', id, memo),
    delete: (id: string): Promise<Account[]> => ipcRenderer.invoke('accounts:delete', id)
  },
  secrets: {
    list: (email: string): Promise<string[]> => ipcRenderer.invoke('secrets:list', email),
    set: (email: string, appId: string, password: string): Promise<boolean> =>
      ipcRenderer.invoke('secrets:set', email, appId, password),
    reveal: (email: string, appId: string): Promise<string | null> =>
      ipcRenderer.invoke('secrets:reveal', email, appId),
    copy: (email: string, appId: string): Promise<boolean> =>
      ipcRenderer.invoke('secrets:copy', email, appId),
    locate: (appId: string, target: 'chrome' | 'keychain'): Promise<string> =>
      ipcRenderer.invoke('secrets:locate', appId, target),
    delete: (email: string, appId: string): Promise<boolean> =>
      ipcRenderer.invoke('secrets:delete', email, appId),
    lockState: (): Promise<LockState> => ipcRenderer.invoke('secrets:lockState'),
    lock: (): Promise<void> => ipcRenderer.invoke('secrets:lock'),
    accessLog: (email?: string, appId?: string): Promise<AccessLogEntry[]> =>
      ipcRenderer.invoke('secrets:accessLog', email, appId),
    updatedAt: (email: string, appId: string): Promise<string | null> =>
      ipcRenderer.invoke('secrets:updatedAt', email, appId),
    securityStatus: (): Promise<{ biometry: boolean; secretCount: number; secretsPath: string }> =>
      ipcRenderer.invoke('secrets:securityStatus')
  }
}

contextBridge.exposeInMainWorld('zto', api)

export type ZtoApi = typeof api
