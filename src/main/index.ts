import {
  app,
  shell,
  BrowserWindow,
  clipboard,
  ipcMain,
  powerMonitor,
  safeStorage,
  systemPreferences
} from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import {
  mailAppForEmail,
  PLATFORM_DOMAINS,
  type AccessLogEntry,
  type Account,
  type DevAccounts,
  type DevAccountState,
  type LockState,
  type RunResult,
  type SheetIapInfo,
  type StoreKind
} from '../shared/launch-types'

const ANSWERS_DIR = join(app.getAppPath(), 'launch', 'answers')

// 전역 로컬 상태 (개발자 계정 보유 여부 등) — 비밀 없음, 메타데이터만
const stateFile = (): string => join(app.getPath('userData'), 'zto-state.json')

function readState(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writeState(state: Record<string, unknown>): void {
  writeFileSync(stateFile(), JSON.stringify(state, null, 2))
}

// 모듈 2 — 계정 인벤토리 저장소 (메타데이터만)
const accountsFile = (): string => join(app.getPath('userData'), 'zto-accounts.json')

// 구 스키마(purpose/services) 마이그레이션 포함 정규화
function readAccounts(): Account[] {
  try {
    const raw: Record<string, unknown>[] = JSON.parse(readFileSync(accountsFile(), 'utf8')).accounts ?? []
    return raw.map((a) => {
      const legacyServices = ((a.services as string[]) ?? []).map((s) =>
        s === 'apple-developer' ? 'app-store-connect' : s
      )
      const email = a.email as string
      let apps = [...new Set([...((a.apps as string[]) ?? []), ...legacyServices])]
      // ID가 이메일이면 해당 메일 서비스를 강제 연결하고 항상 맨 앞에 (유저 설정 불요)
      const mailApp = mailAppForEmail(email)
      if (mailApp) apps = [mailApp, ...apps.filter((x) => x !== mailApp)]
      return {
        id: a.id as string,
        email,
        memo: (a.memo as string) ?? (a.purpose as string) ?? '',
        apps,
        createdAt: a.createdAt as string,
        updatedAt: a.updatedAt as string
      }
    })
  } catch {
    return []
  }
}

function writeAccounts(accounts: Account[]): void {
  writeFileSync(accountsFile(), JSON.stringify({ accounts }, null, 2))
}

// 이메일 기준 업서트 — 같은 이메일이면 새 항목 대신 메모·연결 앱을 병합
function upsertAccount(email: string, patch: { memo?: string; apps?: string[] }): Account[] {
  const accounts = readAccounts()
  const now = new Date().toISOString()
  let account = accounts.find((a) => a.email === email)
  if (!account) {
    account = { id: randomUUID(), email, memo: '', apps: [], createdAt: now, updatedAt: now }
    accounts.push(account)
  }
  if (patch.memo) account.memo = patch.memo
  if (patch.apps) account.apps = [...new Set([...account.apps, ...patch.apps])]
  account.updatedAt = now
  writeAccounts(accounts)
  return accounts
}

// 개발자 계정 이메일이 바뀌면 이전 계정에서 스토어 연결 해제.
// 남은 흔적(강제 메일 앱 제외 연결·비밀번호·메모)이 없으면 계정 자체를 정리한다.
function unlinkStoreFromAccount(email: string, storeApp: string): void {
  let accounts = readAccounts()
  const account = accounts.find((a) => a.email === email)
  if (!account) return
  account.apps = account.apps.filter((x) => x !== storeApp)
  account.updatedAt = new Date().toISOString()
  const mailApp = mailAppForEmail(email)
  const meaningfulApps = account.apps.filter((x) => x !== mailApp)
  const hasSecrets = Object.keys(readSecrets()).some((k) => k.startsWith(email + '::'))
  if (meaningfulApps.length === 0 && !hasSecrets && !account.memo) {
    accounts = accounts.filter((a) => a.id !== account.id)
  }
  writeAccounts(accounts)
}


// ---------- 스토어 실황 조회 헬퍼 ----------
async function googleTokenFor(saPath: string): Promise<string | null> {
  const tokenScript = join(app.getAppPath(), 'launch', 'scripts', 'google', 'token.js')
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [tokenScript, '--sa', saPath],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 },
      (_err, stdout) => {
        try {
          const j = JSON.parse(stdout)
          resolve(j.ok ? j.access_token : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

async function ascTokenFor(asc: { keyPath: string; keyId: string; issuerId: string }): Promise<string | null> {
  const script = join(app.getAppPath(), 'launch', 'scripts', 'apple', 'asc-token.js')
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, '--key', asc.keyPath, '--kid', asc.keyId, '--iss', asc.issuerId],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 },
      (_err, stdout) => {
        try {
          const j = JSON.parse(stdout)
          resolve(j.ok ? j.token : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

function firstAscCreds(): { keyPath: string; keyId: string; issuerId: string } | null {
  if (!existsSync(ANSWERS_DIR)) return null
  for (const f of readdirSync(ANSWERS_DIR).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    try {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, f), 'utf8'))
      const asc = sheet.credentials?.asc
      if (asc?.keyPath && existsSync(asc.keyPath) && asc.keyId && asc.issuerId) return asc
    } catch {
      /* skip */
    }
  }
  return null
}

interface SheetSummary {
  file: string
  appName: string
  packageName: string
  iapCount: number
  icon?: string
}

// 출시된 앱의 아이콘 — Apple 공개 조회(iTunes Lookup) → Play 스토어 페이지 순으로 시도, 로컬 캐시
const iconsDir = (): string => join(app.getPath('userData'), 'app-icons')
const iconPathFor = (file: string): string => join(iconsDir(), file.replace(/\.json$/, '') + '.png')

function iconDataUri(file: string): string | undefined {
  const p = iconPathFor(file)
  if (!existsSync(p)) return undefined
  return 'data:image/png;base64,' + readFileSync(p).toString('base64')
}

async function fetchAppIcon(file: string): Promise<boolean> {
  const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
  mkdirSync(iconsDir(), { recursive: true })
  if (existsSync(iconPathFor(file))) return true
  let url: string | null = null
  try {
    const r = await fetch(
      `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(sheet.app.bundleId)}&country=KR`
    )
    const j = (await r.json()) as { results?: { artworkUrl512?: string; artworkUrl100?: string }[] }
    url = j.results?.[0]?.artworkUrl512 ?? j.results?.[0]?.artworkUrl100 ?? null
  } catch {
    /* 다음 소스로 */
  }
  if (!url) {
    try {
      const r = await fetch(
        `https://play.google.com/store/apps/details?id=${encodeURIComponent(sheet.app.packageName)}&hl=ko`
      )
      if (r.ok) {
        const html = await r.text()
        const mch =
          html.match(/property="og:image"\s+content="([^"]+)"/) ??
          html.match(/content="([^"]+)"\s+property="og:image"/)
        url = mch?.[1] ?? null
      }
    } catch {
      /* 없으면 포기 */
    }
  }
  if (!url) return false
  const imgR = await fetch(url)
  if (!imgR.ok) return false
  writeFileSync(iconPathFor(file), Buffer.from(await imgR.arrayBuffer()))
  return true
}

function listSheets(): SheetSummary[] {
  if (!existsSync(ANSWERS_DIR)) return []
  return readdirSync(ANSWERS_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((file) => {
      try {
        const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
        return {
          file,
          appName: sheet.app?.name ?? file,
          packageName: sheet.app?.packageName ?? '',
          iapCount: Array.isArray(sheet.iap) ? sheet.iap.length : 0,
          icon: iconDataUri(file)
        }
      } catch {
        return { file, appName: `${file} (${mainMsg('parseFail')})`, packageName: '', iapCount: 0 }
      }
    })
}

// 자격증명 보유 점검 — 시트에 적힌 경로의 파일 존재 여부만 본다 (내용은 읽지 않음)
function checkCredentials(file: string): {
  googleSa: { path: string; ok: boolean }
  asc: { keyPath: string; keyId: string; issuerId: string; ok: boolean }
} {
  const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
  const saPath: string = sheet.credentials?.googleSa ?? ''
  const asc = sheet.credentials?.asc ?? {}
  const keyPath: string = asc.keyPath ?? ''
  return {
    googleSa: { path: saPath, ok: !!saPath && existsSync(saPath) },
    asc: {
      keyPath,
      keyId: asc.keyId ?? '',
      issuerId: asc.issuerId ?? '',
      ok: !!keyPath && existsSync(keyPath) && !!asc.keyId && !!asc.issuerId
    }
  }
}

// (계정, 앱)별 비밀번호 — SPEC §7.3 "기기에서만" 모델.
// 암호화 키는 OS 키체인(safeStorage), 여기 파일에는 암호문만. 계정 파일(zto-accounts.json)과 분리.
const secretsFile = (): string => join(app.getPath('userData'), 'zto-secrets.json')
const secretKey = (email: string, appId: string): string => `${email}::${appId}`

interface SecretRecord {
  v: string // safeStorage 암호문 (base64)
  updatedAt: string
}

// 구 포맷(값이 문자열) 마이그레이션 포함
function readSecrets(): Record<string, SecretRecord> {
  try {
    const raw = JSON.parse(readFileSync(secretsFile(), 'utf8')) as Record<
      string,
      string | SecretRecord
    >
    return Object.fromEntries(
      Object.entries(raw).map(([k, val]) => [
        k,
        typeof val === 'string' ? { v: val, updatedAt: '' } : val
      ])
    )
  } catch {
    return {}
  }
}

function writeSecrets(secrets: Record<string, SecretRecord>): void {
  writeFileSync(secretsFile(), JSON.stringify(secrets, null, 2))
}

// 생체인증 관문 — 2FA 필수 정책 (2026-07-22 Dan): Touch ID 불가 기기에서는 조회 자체를 거부.
// 승인 시 30분 잠금 해제 세션. 화면 잠금·잠자기 시 즉시 무효화 (powerMonitor).
const UNLOCK_TTL_MS = 30 * 60_000
let unlockedUntil = 0

// renderer가 동기화해주는 로케일 — main이 만드는 사용자 노출 문구(Touch ID 프롬프트 등)용
let appLocale: 'ko' | 'en' = 'ko'
const MAIN_MSG = {
  ko: { reveal: '비밀번호 보기', copy: '비밀번호 복사', update: '비밀번호 변경', delete: '비밀번호 삭제', deleteAccount: '계정 삭제', parseFail: '파싱 실패' },
  en: { reveal: 'reveal password', copy: 'copy password', update: 'change password', delete: 'delete password', deleteAccount: 'delete account', parseFail: 'parse failed' }
} as const
const mainMsg = (k: keyof (typeof MAIN_MSG)['ko']): string => MAIN_MSG[appLocale][k]

export function lockSecrets(): void {
  unlockedUntil = 0
}

async function biometricGate(reason: string): Promise<void> {
  if (Date.now() < unlockedUntil) return
  await biometricGateStrict(reason)
}

// "보기"(평문 표시)용 — 잠금 해제 세션을 무시하고 항상 재인증 (화면 노출은 위험도가 다름)
async function biometricGateStrict(reason: string): Promise<void> {
  if (process.platform !== 'darwin' || !systemPreferences.canPromptTouchID()) {
    throw new Error('biometric-unavailable')
  }
  await systemPreferences.promptTouchID(reason) // 실패/취소 시 throw
  unlockedUntil = Date.now() + UNLOCK_TTL_MS
}

// 접근 로그 (로컬 전용, 최근 500건 유지)
const accessLogFile = (): string => join(app.getPath('userData'), 'zto-access-log.json')

function logAccess(entry: Omit<AccessLogEntry, 'ts'>): void {
  let log: AccessLogEntry[] = []
  try {
    log = JSON.parse(readFileSync(accessLogFile(), 'utf8'))
  } catch {
    /* 첫 기록 */
  }
  log.push({ ts: new Date().toISOString(), ...entry })
  writeFileSync(accessLogFile(), JSON.stringify(log.slice(-500), null, 2))
}

function decryptSecret(email: string, appId: string): string | null {
  const record = readSecrets()[secretKey(email, appId)]
  if (!record) return null
  return safeStorage.decryptString(Buffer.from(record.v, 'base64'))
}

function createWindow(): void {
  // 지난 실행의 창 크기·위치 복원
  const saved = readState().windowBounds as
    | { width: number; height: number; x?: number; y?: number }
    | undefined
  const mainWindow = new BrowserWindow({
    width: saved?.width ?? 1200,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'ZTO',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  const saveBounds = (): void => {
    if (!mainWindow.isDestroyed() && !mainWindow.isFullScreen()) {
      writeState({ ...readState(), windowBounds: mainWindow.getBounds() })
    }
  }
  mainWindow.on('resized', saveBounds)
  mainWindow.on('moved', saveBounds)
  mainWindow.on('close', saveBounds)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 기기가 손을 떠나는 순간 비밀번호 세션 종료
  powerMonitor.on('lock-screen', lockSecrets)
  powerMonitor.on('suspend', lockSecrets)

  ipcMain.handle('ping', () => 'pong')
  ipcMain.handle('app:setLocale', (_e, locale: 'ko' | 'en'): void => {
    appLocale = locale
  })
  ipcMain.handle('launch:listSheets', () => listSheets())
  ipcMain.handle('launch:checkCredentials', (_e, file: string) => checkCredentials(file))
  // GUI에서 답안 시트 생성 — 2단계가 파일 작업 없이 앱 안에서 완결되도록
  ipcMain.handle(
    'launch:createSheet',
    (
      _e,
      name: string,
      packageName: string,
      bundleId: string
    ): { ok: boolean; file?: string; error?: string } => {
      const slug = (packageName.split('.').pop() || name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
      if (!slug) return { ok: false, error: 'invalid-name' }
      const file = `${slug}.json`
      const path = join(ANSWERS_DIR, file)
      if (existsSync(path)) return { ok: false, error: 'exists' }
      const sheet = {
        app: { name, packageName, bundleId: bundleId || packageName },
        iap: [],
        credentials: { googleSa: '', asc: { keyPath: '', keyId: '', issuerId: '' } },
        console_answers: { data_safety: {}, content_rating: {}, app_access: '', review_notes: '' }
      }
      writeFileSync(path, JSON.stringify(sheet, null, 2))
      return { ok: true, file }
    }
  )
  // 기존 앱 가져오기 — 패키지명 실존·접근 검증(SA 제공 시) 후 시트 생성
  ipcMain.handle(
    'launch:importApp',
    async (
      _e,
      name: string,
      packageName: string,
      saPath: string
    ): Promise<{ ok: boolean; file?: string; verified?: boolean; error?: string; detail?: string }> => {
      const slug = (packageName.split('.').pop() || name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
      if (!slug || !packageName) return { ok: false, error: 'invalid-name' }
      const file = `${slug}.json`
      const path = join(ANSWERS_DIR, file)
      if (existsSync(path)) return { ok: false, error: 'exists' }

      let verified = false
      if (saPath) {
        if (!existsSync(saPath)) return { ok: false, error: 'verify-failed', detail: 'SA file not found' }
        const tokenScript = join(app.getAppPath(), 'launch', 'scripts', 'google', 'token.js')
        const tok = await new Promise<{ ok?: boolean; access_token?: string } | null>((resolve) => {
          execFile(
            process.execPath,
            [tokenScript, '--sa', saPath],
            { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 },
            (_err, stdout) => {
              try {
                resolve(JSON.parse(stdout))
              } catch {
                resolve(null)
              }
            }
          )
        })
        if (!tok?.ok || !tok.access_token) {
          return { ok: false, error: 'verify-failed', detail: 'token' }
        }
        const r = await fetch(
          `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/oneTimeProducts`,
          { headers: { Authorization: 'Bearer ' + tok.access_token } }
        )
        if (!r.ok) return { ok: false, error: 'verify-failed', detail: `HTTP ${r.status}` }
        verified = true
        writeState({ ...readState(), lastGoogleSa: saPath })
      }

      const sheet = {
        app: { name: name || slug, packageName, bundleId: packageName },
        iap: [],
        credentials: { googleSa: saPath || '', asc: { keyPath: '', keyId: '', issuerId: '' } },
        console_answers: { data_safety: {}, content_rating: {}, app_access: '', review_notes: '' }
      }
      writeFileSync(path, JSON.stringify(sheet, null, 2))
      return { ok: true, file, verified }
    }
  )
  // 스토어 실황 IAP — 기존 앱은 스토어가 진실 (iOS/Android 별도)
  ipcMain.handle(
    'launch:storeIap',
    async (
      _e,
      file: string
    ): Promise<{
      google: { id: string; title: string; state: string }[] | null
      googleError?: string
      apple: { id: string; name: string; state: string }[] | null
      appleError?: string
    }> => {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      const result: {
        google: { id: string; title: string; state: string }[] | null
        googleError?: string
        apple: { id: string; name: string; state: string }[] | null
        appleError?: string
      } = { google: null, apple: null }

      const saPath = sheet.credentials?.googleSa
      if (saPath && existsSync(saPath)) {
        const tok = await googleTokenFor(saPath)
        if (!tok) result.googleError = 'token'
        else {
          const r = await fetch(
            `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(sheet.app.packageName)}/oneTimeProducts`,
            { headers: { Authorization: 'Bearer ' + tok } }
          )
          if (!r.ok) result.googleError = `HTTP ${r.status}`
          else {
            interface GProduct {
              productId?: string
              listings?: { title?: string }[]
              purchaseOptions?: { state?: string }[]
            }
            const j = (await r.json()) as { oneTimeProducts?: GProduct[] }
            result.google = (j.oneTimeProducts ?? []).map((prod) => ({
              id: prod.productId ?? '',
              title: prod.listings?.[0]?.title ?? '',
              state: prod.purchaseOptions?.[0]?.state ?? ''
            }))
          }
        }
      } else result.googleError = 'no-key'

      const asc = sheet.credentials?.asc
      if (asc?.keyPath && existsSync(asc.keyPath) && asc.keyId && asc.issuerId) {
        const tok = await ascTokenFor(asc)
        if (!tok) result.appleError = 'token'
        else {
          const headers = { Authorization: 'Bearer ' + tok }
          const appsR = await fetch(
            `https://api.appstoreconnect.apple.com/v1/apps?filter%5BbundleId%5D=${encodeURIComponent(sheet.app.bundleId)}`,
            { headers }
          )
          if (!appsR.ok) result.appleError = `HTTP ${appsR.status}`
          else {
            const appsJ = (await appsR.json()) as { data?: { id: string }[] }
            const appId = appsJ.data?.[0]?.id
            if (!appId) result.appleError = 'app-not-found'
            else {
              const iapR = await fetch(
                `https://api.appstoreconnect.apple.com/v1/apps/${appId}/inAppPurchasesV2?limit=50`,
                { headers }
              )
              if (!iapR.ok) result.appleError = `HTTP ${iapR.status}`
              else {
                const iapJ = (await iapR.json()) as {
                  data?: { attributes?: { productId?: string; name?: string; state?: string } }[]
                }
                result.apple = (iapJ.data ?? []).map((d) => ({
                  id: d.attributes?.productId ?? '',
                  name: d.attributes?.name ?? '',
                  state: d.attributes?.state ?? ''
                }))
              }
            }
          }
        }
      } else result.appleError = 'no-key'

      return result
    }
  )
  // Apple 계정의 앱 목록 — 가져오기에서 클릭 선택용 (Play는 목록 API가 없음)
  ipcMain.handle(
    'launch:listAscApps',
    async (): Promise<{ name: string; bundleId: string }[]> => {
      const asc = firstAscCreds()
      if (!asc) return []
      const tok = await ascTokenFor(asc)
      if (!tok) return []
      const r = await fetch('https://api.appstoreconnect.apple.com/v1/apps?limit=50', {
        headers: { Authorization: 'Bearer ' + tok }
      })
      if (!r.ok) return []
      const j = (await r.json()) as {
        data?: { attributes?: { name?: string; bundleId?: string } }[]
      }
      return (j.data ?? []).map((d) => ({
        name: d.attributes?.name ?? '',
        bundleId: d.attributes?.bundleId ?? ''
      }))
    }
  )
  ipcMain.handle('launch:fetchIcon', async (_e, file: string): Promise<boolean> => {
    return await fetchAppIcon(file)
  })
  ipcMain.handle('launch:lastSa', (): string => (readState().lastGoogleSa as string) ?? '')
  // 앱별 출시 여정 진행 상태 — 시트에 저장 (며칠 걸리는 여정의 이어하기)
  ipcMain.handle('launch:getJourney', (_e, file: string): { registered: boolean } => {
    try {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      return { registered: !!sheet.journey?.registered }
    } catch {
      return { registered: false }
    }
  })
  ipcMain.handle(
    'launch:setJourney',
    (_e, file: string, registered: boolean): { registered: boolean } => {
      const path = join(ANSWERS_DIR, file)
      const sheet = JSON.parse(readFileSync(path, 'utf8'))
      sheet.journey = { ...(sheet.journey ?? {}), registered }
      writeFileSync(path, JSON.stringify(sheet, null, 2))
      return { registered }
    }
  )
  ipcMain.handle('launch:sheetIap', (_e, file: string): SheetIapInfo => {
    const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
    interface RawIap {
      productId?: string
      listings?: Record<string, { title?: string }>
      price?: Record<string, string>
      currency?: Record<string, string>
    }
    const products = ((sheet.iap ?? []) as RawIap[]).map((p) => {
      const firstListing = Object.values(p.listings ?? {})[0]
      const [region, units] = Object.entries(p.price ?? {})[0] ?? []
      return {
        productId: p.productId ?? '',
        title: firstListing?.title ?? '',
        priceLabel: region ? `${units} ${p.currency?.[region] ?? region}` : ''
      }
    })
    return { packageName: sheet.app?.packageName ?? '', products }
  })
  // 검증된 CLI 실행 — 스크립트는 화이트리스트 고정, 인자는 시트에서 main이 직접 구성
  ipcMain.handle(
    'launch:runIap',
    async (_e, file: string, action: 'upsert' | 'activate'): Promise<RunResult> => {
      const sheet = JSON.parse(readFileSync(join(ANSWERS_DIR, file), 'utf8'))
      const saPath: string = sheet.credentials?.googleSa ?? ''
      if (!saPath || !existsSync(saPath)) return { ok: false, output: 'google-sa-missing' }
      const script = join(
        app.getAppPath(),
        'launch',
        'scripts',
        'google',
        action === 'upsert' ? 'otp-upsert.js' : 'otp-activate.js'
      )
      const answersPath = join(ANSWERS_DIR, file)
      return await new Promise<RunResult>((resolve) => {
        execFile(
          process.execPath,
          [script, '--sa', saPath, '--answers', answersPath],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60_000 },
          (err, stdout, stderr) => {
            let parsed: unknown = null
            try {
              parsed = JSON.parse(stdout)
            } catch {
              /* 원문 유지 */
            }
            const okFlag =
              parsed !== null && typeof parsed === 'object' && 'ok' in (parsed as object)
                ? Boolean((parsed as { ok: unknown }).ok)
                : !err
            resolve({
              ok: !err && okFlag,
              output: parsed ?? stdout.slice(0, 4000),
              stderr: stderr ? stderr.slice(0, 2000) : undefined
            })
          }
        )
      })
    }
  )
  ipcMain.handle('launch:getDevAccounts', (): DevAccounts => {
    return (readState().devAccounts as DevAccounts) ?? {}
  })
  ipcMain.handle(
    'launch:setDevAccount',
    (_e, store: StoreKind, info: DevAccountState): DevAccounts => {
      const state = readState()
      const storeApp = store === 'play' ? 'play-console' : 'app-store-connect'
      const prev = ((state.devAccounts as DevAccounts) ?? {})[store]
      // 이메일이 바뀌거나 제거되면 이전 계정의 연결을 정리 (오타 계정 잔존 방지)
      if (prev?.email && prev.email !== info.email) {
        unlinkStoreFromAccount(prev.email, storeApp)
      }
      const devAccounts = { ...((state.devAccounts as DevAccounts) ?? {}), [store]: info }
      writeState({ ...state, devAccounts })
      // "있음" + 이메일 입력 시 계정 인벤토리에 자동 등록·연동 (모듈 1 → 모듈 2)
      if (info.status === 'yes' && info.email) {
        upsertAccount(info.email, { apps: [storeApp] })
      }
      return devAccounts
    }
  )
  ipcMain.handle('accounts:list', (): Account[] => readAccounts())
  ipcMain.handle('accounts:add', (_e, email: string, memo: string, apps: string[]): Account[] => {
    return upsertAccount(email, { memo, apps })
  })
  // 계정 삭제 — 저장된 비밀번호가 있으면 인증 필요(파괴적), 해당 이메일의 암호문도 함께 정리
  ipcMain.handle('accounts:delete', async (_e, id: string): Promise<Account[]> => {
    const accounts = readAccounts()
    const account = accounts.find((a) => a.id === id)
    if (!account) return accounts
    const secrets = readSecrets()
    const keys = Object.keys(secrets).filter((k) => k.startsWith(account.email + '::'))
    if (keys.length > 0) {
      await biometricGate(`${account.email} ${mainMsg('deleteAccount')}`)
      keys.forEach((k) => delete secrets[k])
      writeSecrets(secrets)
    }
    const remaining = accounts.filter((a) => a.id !== id)
    writeAccounts(remaining)
    return remaining
  })
  ipcMain.handle('accounts:setMemo', (_e, id: string, memo: string): Account[] => {
    const accounts = readAccounts()
    const account = accounts.find((a) => a.id === id)
    if (account) {
      account.memo = memo
      account.updatedAt = new Date().toISOString()
      writeAccounts(accounts)
    }
    return accounts
  })
  ipcMain.handle('accounts:setApps', (_e, id: string, apps: string[]): Account[] => {
    const accounts = readAccounts()
    const account = accounts.find((a) => a.id === id)
    if (account) {
      account.apps = apps
      account.updatedAt = new Date().toISOString()
      writeAccounts(accounts)
    }
    return accounts
  })

  // 비밀번호 저장/조회 — 전부 로컬, 네트워크 없음
  ipcMain.handle('secrets:list', (_e, email: string): string[] => {
    const prefix = email + '::'
    return Object.keys(readSecrets())
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
  })
  ipcMain.handle(
    'secrets:set',
    async (_e, email: string, appId: string, password: string): Promise<boolean> => {
      if (!safeStorage.isEncryptionAvailable()) return false
      const secrets = readSecrets()
      const exists = secretKey(email, appId) in secrets
      // 첫 저장은 무인증(기존 비밀을 건드리지 않음), 변경은 파괴적이므로 인증 필요
      if (exists) {
        try {
          await biometricGate(`${email} · ${appId} ${mainMsg('update')}`)
        } catch (e) {
          logAccess({ email, appId, action: 'update', ok: false })
          throw e
        }
      }
      secrets[secretKey(email, appId)] = {
        v: safeStorage.encryptString(password).toString('base64'),
        updatedAt: new Date().toISOString()
      }
      writeSecrets(secrets)
      logAccess({ email, appId, action: exists ? 'update' : 'save', ok: true })
      return true
    }
  )
  ipcMain.handle('secrets:reveal', async (_e, email: string, appId: string): Promise<string | null> => {
    try {
      // 평문 표시는 세션 무시, 항상 재인증
      await biometricGateStrict(`${email} · ${appId} ${mainMsg('reveal')}`)
    } catch (e) {
      logAccess({ email, appId, action: 'reveal', ok: false })
      throw e
    }
    logAccess({ email, appId, action: 'reveal', ok: true })
    return decryptSecret(email, appId)
  })
  ipcMain.handle('secrets:copy', async (_e, email: string, appId: string): Promise<boolean> => {
    try {
      await biometricGate(`${email} · ${appId} ${mainMsg('copy')}`)
    } catch (e) {
      logAccess({ email, appId, action: 'copy', ok: false })
      throw e
    }
    const value = decryptSecret(email, appId)
    if (value === null) return false
    logAccess({ email, appId, action: 'copy', ok: true })
    clipboard.writeText(value)
    setTimeout(() => {
      if (clipboard.readText() === value) clipboard.clear()
    }, 30_000)
    return true
  })
  ipcMain.handle('secrets:lockState', (): LockState => {
    const remainingMs = Math.max(0, unlockedUntil - Date.now())
    return { unlocked: remainingMs > 0, remainingMs }
  })
  ipcMain.handle('secrets:lock', (): void => lockSecrets())
  ipcMain.handle('secrets:accessLog', (_e, email?: string, appId?: string): AccessLogEntry[] => {
    try {
      let log = JSON.parse(readFileSync(accessLogFile(), 'utf8')) as AccessLogEntry[]
      if (email) log = log.filter((x) => x.email === email)
      if (appId) log = log.filter((x) => x.appId === appId)
      return log.slice(-30).reverse()
    } catch {
      return []
    }
  })
  ipcMain.handle('secrets:updatedAt', (_e, email: string, appId: string): string | null => {
    return readSecrets()[secretKey(email, appId)]?.updatedAt || null
  })
  ipcMain.handle(
    'secrets:securityStatus',
    (): { biometry: boolean; secretCount: number; secretsPath: string } => ({
      biometry: process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
      secretCount: Object.keys(readSecrets()).length,
      secretsPath: secretsFile()
    })
  )
  // 기기의 비밀번호 관리자로 안내 — 검색어(도메인)를 클립보드에 복사하고 해당 창을 연다.
  // Chrome/암호 앱 모두 검색어 주입 딥링크가 없어서 "복사 + 열기"가 최선 (2026-07-22 실기기 검증).
  ipcMain.handle(
    'secrets:locate',
    (_e, appId: string, target: 'chrome' | 'keychain'): string => {
      const term = PLATFORM_DOMAINS[appId] ?? appId
      clipboard.writeText(term)
      if (target === 'chrome') {
        execFile('open', ['-a', 'Google Chrome', 'chrome://password-manager/passwords'])
      } else {
        execFile('open', ['-a', 'Passwords'], (err) => {
          if (err) execFile('open', ['x-apple.systempreferences:com.apple.Passwords-Settings.extension'])
        })
      }
      return term
    }
  )
  ipcMain.handle('secrets:delete', async (_e, email: string, appId: string): Promise<boolean> => {
    try {
      await biometricGate(`${email} · ${appId} ${mainMsg('delete')}`)
    } catch (e) {
      logAccess({ email, appId, action: 'delete', ok: false })
      throw e
    }
    const secrets = readSecrets()
    delete secrets[secretKey(email, appId)]
    writeSecrets(secrets)
    logAccess({ email, appId, action: 'delete', ok: true })
    return true
  })
  ipcMain.handle('launch:openExternal', (_e, url: string) => {
    if (url.startsWith('https://')) shell.openExternal(url)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
