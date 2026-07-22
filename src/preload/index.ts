import { contextBridge, ipcRenderer } from 'electron'
import type {
  AccessLogEntry,
  Account,
  CredentialStatus,
  DevAccounts,
  DevAccountState,
  LockState,
  SheetSummary,
  StoreKind
} from '../shared/launch-types'

const api = {
  platform: process.platform,
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  setLocale: (locale: 'ko' | 'en'): Promise<void> => ipcRenderer.invoke('app:setLocale', locale),
  launch: {
    listSheets: (): Promise<SheetSummary[]> => ipcRenderer.invoke('launch:listSheets'),
    checkCredentials: (file: string): Promise<CredentialStatus> =>
      ipcRenderer.invoke('launch:checkCredentials', file),
    getDevAccounts: (): Promise<DevAccounts> => ipcRenderer.invoke('launch:getDevAccounts'),
    setDevAccount: (store: StoreKind, info: DevAccountState): Promise<DevAccounts> =>
      ipcRenderer.invoke('launch:setDevAccount', store, info),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('launch:openExternal', url)
  },
  accounts: {
    list: (): Promise<Account[]> => ipcRenderer.invoke('accounts:list'),
    add: (email: string, memo: string, apps: string[]): Promise<Account[]> =>
      ipcRenderer.invoke('accounts:add', email, memo, apps),
    setApps: (id: string, apps: string[]): Promise<Account[]> =>
      ipcRenderer.invoke('accounts:setApps', id, apps),
    setMemo: (id: string, memo: string): Promise<Account[]> =>
      ipcRenderer.invoke('accounts:setMemo', id, memo)
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
