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
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
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

interface SheetSummary {
  file: string
  appName: string
  packageName: string
  iapCount: number
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
          iapCount: Array.isArray(sheet.iap) ? sheet.iap.length : 0
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
  ko: { reveal: '비밀번호 보기', copy: '비밀번호 복사', update: '비밀번호 변경', delete: '비밀번호 삭제', parseFail: '파싱 실패' },
  en: { reveal: 'reveal password', copy: 'copy password', update: 'change password', delete: 'delete password', parseFail: 'parse failed' }
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
  ipcMain.handle('launch:getDevAccounts', (): DevAccounts => {
    return (readState().devAccounts as DevAccounts) ?? {}
  })
  ipcMain.handle(
    'launch:setDevAccount',
    (_e, store: StoreKind, info: DevAccountState): DevAccounts => {
      const state = readState()
      const devAccounts = { ...((state.devAccounts as DevAccounts) ?? {}), [store]: info }
      writeState({ ...state, devAccounts })
      // "있음" + 이메일 입력 시 계정 인벤토리에 자동 등록·연동 (모듈 1 → 모듈 2)
      if (info.status === 'yes' && info.email) {
        upsertAccount(info.email, {
          apps: [store === 'play' ? 'play-console' : 'app-store-connect']
        })
      }
      return devAccounts
    }
  )
  ipcMain.handle('accounts:list', (): Account[] => readAccounts())
  ipcMain.handle('accounts:add', (_e, email: string, memo: string, apps: string[]): Account[] => {
    return upsertAccount(email, { memo, apps })
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
