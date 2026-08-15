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
  SecretVersion,
  SheetIapInfo,
  SheetListing,
  SheetSummary,
  StoreKind,
  StoreSnapshotEntry
} from '../shared/launch-types'
import type { LicenseInfo } from '../shared/license-types'
import type { UpdateStatus } from '../shared/update-types'
import type { BrowserBounds, BrowserResult, BrowserState } from '../shared/browser-types'

import type {
  AppContentProbeDoc,
  DataSafetyDoc,
  FormChange,
  PullResult
} from '../shared/console-types'

// 고른 자산 — 미리보기는 zto-asset:// (userData/assets 사본), 업로드는 원본 path로 한다
export interface PickedAsset {
  path: string
  name: string
  width: number
  height: number
  preview: string
}
export interface PickedAssets {
  ok: boolean
  canceled?: boolean
  error?: string
  files: PickedAsset[]
}

const api = {
  platform: process.platform,
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  setLocale: (locale: 'ko' | 'en'): Promise<void> => ipcRenderer.invoke('app:setLocale', locale),
  // ⌘1..3 — 임베드 브라우저가 키보드를 쥐고 있을 때 main이 대신 넘겨주는 모듈 전환
  onModuleKey: (cb: (n: number) => void): (() => void) => {
    const l = (_e: unknown, n: number): void => cb(n)
    ipcRenderer.on('app:module', l)
    return () => ipcRenderer.removeListener('app:module', l)
  },
  getLocale: (): Promise<'ko' | 'en'> => ipcRenderer.invoke('app:getLocale'),
  // #4 ZTO 자체 브라우저 — WebContentsView 임베드·네비게이트·eval/CDP 제어
  browser: {
    // space: 콘솔·소셜이 딴 방(탭 세트)을 쓴다 — 어느 방을 붙일지는 화면이 안다
    attach: (bounds: BrowserBounds, space?: 'console' | 'social'): Promise<boolean> =>
      ipcRenderer.invoke('browser:attach', bounds, space),
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
    probeForm: (): Promise<BrowserResult> => ipcRenderer.invoke('browser:probeForm'),
    // 지금 화면의 글 — '읽기' 토글이 켜져 있을 때 사용자가 물으면 그 순간에만 부른다
    pageText: (kind?: 'text' | 'html'): Promise<BrowserResult> =>
      ipcRenderer.invoke('browser:pageText', kind ?? 'text'),
    // AI가 찾아보러 갈 때 — 새 탭에서 열고 다 뜨면 읽어 돌려준다
    openAndRead: (url: string): Promise<BrowserResult> =>
      ipcRenderer.invoke('browser:openAndRead', url),
    // 폼 따라가기 — 켠 동안만 main이 폴링한다. 해제 함수를 돌려주므로 언마운트 시 반드시 끈다.
    watchForm: (on: boolean): Promise<boolean> => ipcRenderer.invoke('browser:watchForm', on),
    onFormChanged: (cb: (c: FormChange) => void): (() => void) => {
      const l = (_e: unknown, c: FormChange): void => cb(c)
      ipcRenderer.on('browser:formChanged', l)
      return () => ipcRenderer.removeListener('browser:formChanged', l)
    },
    crawlConsole: (): Promise<BrowserResult> => ipcRenderer.invoke('browser:crawlConsole'),
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
        // 역할·도구 규약. claude CLI에선 --system-prompt로 **기본 시스템 프롬프트를 대체**한다 —
        // 안 그러면 코딩 에이전트로 프라이밍된 채라 우리 규약과 자기 도구가 경쟁한다
        system?: string
      }
    ): Promise<AiChatResult> => ipcRenderer.invoke('ai:chat', prompt, opts),
    usage: (): Promise<AiUsageEntry[]> => ipcRenderer.invoke('ai:usage'),
    usageClear: (): Promise<boolean> => ipcRenderer.invoke('ai:usageClear')
  },
  console: {
    pullDataSafety: (
      file: string,
      askLogin?: string,
      askChooseDev?: string,
      askExport?: string
    ): Promise<PullResult> =>
      ipcRenderer.invoke('console:pullDataSafety', file, askLogin, askChooseDev, askExport),
    dataSafetyDoc: (file: string): Promise<(DataSafetyDoc & { at?: string }) | null> =>
      ipcRenderer.invoke('console:dataSafetyDoc', file),
    probeAppContent: (
      file: string,
      askLogin?: string,
      askChooseDev?: string
    ): Promise<{
      ok: boolean
      step: string
      doc?: AppContentProbeDoc
      consoleBase?: string
      error?: string
    }> => ipcRenderer.invoke('console:probeAppContent', file, askLogin, askChooseDev),
    // 정찰이 수확해 둔 콘솔 링크(읽기 전용). 없으면 null — 그땐 콘솔 홈으로 보낸다
    appContentLinks: (
      file: string
    ): Promise<{ consoleBase: string; forms: { slug: string; label: string; url: string }[] } | null> =>
      ipcRenderer.invoke('console:appContentLinks', file),
    onProgress: (cb: (p: { step: string; detail?: string }) => void): (() => void) => {
      const l = (_e: unknown, p: { step: string; detail?: string }): void => cb(p)
      ipcRenderer.on('console:progress', l)
      return () => ipcRenderer.removeListener('console:progress', l)
    }
  },
  // 자동 업데이트 — 다운로드는 자동, **재시작은 사용자가** 누른다
  update: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    onStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const l = (_e: unknown, s: UpdateStatus): void => cb(s)
      ipcRenderer.on('update:status', l)
      return () => ipcRenderer.removeListener('update:status', l)
    }
  },
  // 라이선스 (SPEC §8) — 검증은 Lemon Squeezy 공개 API를 main이 직접 부른다(서버 없음)
  license: {
    info: (): Promise<LicenseInfo> => ipcRenderer.invoke('license:info'),
    activate: (key: string): Promise<LicenseInfo> => ipcRenderer.invoke('license:activate', key),
    deactivate: (): Promise<LicenseInfo> => ipcRenderer.invoke('license:deactivate')
  },
  // 로컬 데이터 삭제 — 라이선스 파일만 남는다(무료 사용 기록이 거기 있다)
  data: {
    wipe: (): Promise<number> => ipcRenderer.invoke('data:wipe'),
    relaunch: (): Promise<void> => ipcRenderer.invoke('data:relaunch'),
    // 지금 보고 있는 데이터 방 — name이 비면 기본(진짜) 프로필
    profile: (): Promise<{ name: string; dir: string }> => ipcRenderer.invoke('data:profile')
  },
  launch: {
    // 자산 파일 고르기 — main이 규격까지 검증해서 돌려준다(통과 못 하면 ok:false + 사유)
    // platform은 검증기를 고른다 — 'ios'면 기기별 스크린샷 규격(+알파 채널 검사), 없으면 Play
    pickAssets: (imageType: string, platform?: 'android' | 'ios'): Promise<PickedAssets> =>
      ipcRenderer.invoke('launch:pickAssets', imageType, platform),
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
      bundleId: string,
      about?: string // 자연어 "이 앱이 뭔지" — 이후 AI 초안의 기준
      // detail = 선점된 번들 ID의 임자(앱 이름 — 개발자)
    ): Promise<{ ok: boolean; file?: string; error?: string; detail?: string }> =>
      ipcRenderer.invoke('launch:createSheet', name, packageName, bundleId, about),
    // 신규 앱 여정 ① — 시트의 bundleId를 ASC에 등록(멱등). developer.apple.com 관문 제거
    registerBundleId: (
      file: string
    ): Promise<{ ok: boolean; already?: boolean; error?: string; detail?: string }> =>
      ipcRenderer.invoke('launch:registerBundleId', file),
    // 신규 앱 여정 ② — 콘텐츠(리스팅) 초안. 시트가 단일 진실
    getListing: (file: string): Promise<SheetListing | null> =>
      ipcRenderer.invoke('launch:getListing', file),
    saveListing: (file: string, listing: SheetListing): Promise<boolean> =>
      ipcRenderer.invoke('launch:saveListing', file, listing),
    pickListingIcon: (file: string): Promise<{ ok: boolean; name?: string; error?: string }> =>
      ipcRenderer.invoke('launch:pickListingIcon', file),
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
    // 자격증명 등록 — 고르고, **검증에 통과해야** 저장된다
    pickCredential: (store: StoreKind): Promise<{ path: string }> =>
      ipcRenderer.invoke('launch:pickCredential', store),
    saveCredential: (
      store: StoreKind,
      creds: { path: string; keyId?: string; issuerId?: string }
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('launch:saveCredential', store, creds),
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
    // 개명은 비밀번호 키·접근 로그까지 함께 옮긴다 → 성공 여부와 사유를 돌려준다
    rename: (
      id: string,
      email: string
    ): Promise<{ ok: boolean; error?: string; accounts: Account[] }> =>
      ipcRenderer.invoke('accounts:rename', id, email),
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
    // 교체된 옛 비밀번호 — 목록은 무인증(시각만), 값은 revealPrev가 매번 생체 관문
    history: (email: string, appId: string): Promise<SecretVersion[]> =>
      ipcRenderer.invoke('secrets:history', email, appId),
    revealPrev: (email: string, appId: string, at: string): Promise<string | null> =>
      ipcRenderer.invoke('secrets:revealPrev', email, appId, at),
    securityStatus: (): Promise<{ biometry: boolean; secretCount: number; secretsPath: string }> =>
      ipcRenderer.invoke('secrets:securityStatus')
  }
}

contextBridge.exposeInMainWorld('zto', api)

export type ZtoApi = typeof api
