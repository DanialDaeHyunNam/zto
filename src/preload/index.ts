import { contextBridge, ipcRenderer } from 'electron'
import type {
  AccessLogEntry,
  Account,
  AiChatResult,
  AiFeature,
  AiMode,
  AiProviderId,
  AiStatus,
  AiUsageEntry,
  ApiStatus,
  ApplyResult,
  ConsoleAnswers,
  CredentialStatus,
  DashboardData,
  Questionnaire,
  QuestionnaireMeta,
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
import type { BrowserBounds, BrowserResult, BrowserState } from '../shared/browser-types'

const api = {
  platform: process.platform,
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  setLocale: (locale: 'ko' | 'en'): Promise<void> => ipcRenderer.invoke('app:setLocale', locale),
  getLocale: (): Promise<'ko' | 'en'> => ipcRenderer.invoke('app:getLocale'),
  // #4 ZTO 자체 브라우저 — WebContentsView 임베드·네비게이트·eval/CDP 제어
  browser: {
    attach: (bounds: BrowserBounds): Promise<boolean> =>
      ipcRenderer.invoke('browser:attach', bounds),
    setBounds: (bounds: BrowserBounds): Promise<void> =>
      ipcRenderer.invoke('browser:setBounds', bounds),
    detach: (): Promise<void> => ipcRenderer.invoke('browser:detach'),
    navigate: (url: string): Promise<BrowserResult> => ipcRenderer.invoke('browser:navigate', url),
    newTab: (url?: string): Promise<void> => ipcRenderer.invoke('browser:newTab', url),
    closeTab: (id: string): Promise<void> => ipcRenderer.invoke('browser:closeTab', id),
    selectTab: (id: string): Promise<void> => ipcRenderer.invoke('browser:selectTab', id),
    moveTab: (id: string, toIndex: number): Promise<void> =>
      ipcRenderer.invoke('browser:moveTab', id, toIndex),
    back: (): Promise<void> => ipcRenderer.invoke('browser:back'),
    forward: (): Promise<void> => ipcRenderer.invoke('browser:forward'),
    reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),
    eval: (js: string): Promise<BrowserResult> => ipcRenderer.invoke('browser:eval', js),
    capture: (): Promise<string | null> => ipcRenderer.invoke('browser:capture'),
    cdp: (method: string, params?: object): Promise<BrowserResult> =>
      ipcRenderer.invoke('browser:cdp', method, params),
    // 네비게이션 상태 구독 — 언구독 함수 반환
    onState: (cb: (s: BrowserState) => void): (() => void) => {
      const listener = (_e: unknown, s: BrowserState): void => cb(s)
      ipcRenderer.on('browser:state', listener)
      return () => ipcRenderer.removeListener('browser:state', listener)
    }
  },
  ai: {
    status: (fresh?: boolean): Promise<AiStatus> => ipcRenderer.invoke('ai:status', fresh),
    setModel: (model: string): Promise<void> => ipcRenderer.invoke('ai:setModel', model),
    setActive: (provider: AiProviderId): Promise<void> =>
      ipcRenderer.invoke('ai:setActive', provider),
    setMode: (provider: AiProviderId, mode: AiMode): Promise<void> =>
      ipcRenderer.invoke('ai:setMode', provider, mode),
    setKey: (provider: AiProviderId, key: string): Promise<boolean> =>
      ipcRenderer.invoke('ai:setKey', provider, key),
    chat: (
      prompt: string,
      opts?: {
        resume?: string
        images?: { mediaType: string; data: string }[]
        feature?: AiFeature
      }
    ): Promise<AiChatResult> => ipcRenderer.invoke('ai:chat', prompt, opts),
    usage: (): Promise<AiUsageEntry[]> => ipcRenderer.invoke('ai:usage'),
    usageClear: (): Promise<boolean> => ipcRenderer.invoke('ai:usageClear')
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
    questionnaireList: (): Promise<QuestionnaireMeta[]> =>
      ipcRenderer.invoke('launch:questionnaireList'),
    getConsoleAnswers: (file: string, id: string): Promise<ConsoleAnswers | null> =>
      ipcRenderer.invoke('launch:getConsoleAnswers', file, id),
    setConsoleAnswers: (file: string, id: string, data: ConsoleAnswers): Promise<void> =>
      ipcRenderer.invoke('launch:setConsoleAnswers', file, id, data),
    ageRatingDeclaration: (file: string): Promise<Record<string, string> | null> =>
      ipcRenderer.invoke('launch:ageRatingDeclaration', file),
    applyEdits: (file: string, edits: PendingEdit[]): Promise<ApplyResult[]> =>
      ipcRenderer.invoke('launch:applyEdits', file, edits),
    createIosVersion: (
      file: string,
      versionString: string
    ): Promise<{ ok: boolean; error?: string; versionId?: string }> =>
      ipcRenderer.invoke('launch:createIosVersion', file, versionString),
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
