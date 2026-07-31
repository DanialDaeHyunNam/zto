// ---------- 자동 업데이트 (electron-updater) ----------
// 유료 사용자에게 **고칠 방법이 없는 상태**로 파는 게 가장 위험하다. ROADMAP #7.
//
// ⚠️ 자동 설치는 하지 않는다. ZTO는 라이브 스토어를 **비가역으로 바꾸는** 작업을 한다 —
// 자산 업로드·IAP 반영 도중에 앱이 스스로 재시작하면 무엇이 반영됐는지 모르는 상태가 된다.
// 그래서 다운로드까지만 자동, **재시작은 사람이 누른다**(SPEC §3의 "비가역 액션은 사람 컨펌"과 같은 결).
//
// 채널은 호스트에 안 묶는다: `publish: generic` + 빌드 시 `ZTO_UPDATE_URL` 주입.
// GitHub Releases든 오브젝트 스토리지든 정적 파일만 놓을 수 있으면 된다.
import { app, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  version: string // 지금 돌고 있는 버전
  newVersion?: string
  percent?: number
  error?: string
  // 개발 중이거나 채널이 설정 안 된 빌드 — 화면이 "확인 중"으로 멈춰 있지 않게 사실을 말한다
  disabled?: boolean
}

const SIX_HOURS = 6 * 60 * 60 * 1000

export function createUpdater(getWindow: () => BrowserWindow | null) {
  let status: UpdateStatus = { phase: 'idle', version: app.getVersion() }
  // 패키징 안 된 앱에선 electron-updater가 동작하지 않는다(개발 중엔 그게 정상)
  const enabled = app.isPackaged

  const push = (next: Partial<UpdateStatus>): void => {
    status = { ...status, ...next }
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('update:status', status)
  }

  if (!enabled) status.disabled = true

  if (enabled) {
    // 다운로드는 자동, **설치는 수동** (위 주석)
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => push({ phase: 'checking', error: undefined }))
    autoUpdater.on('update-available', (i) => push({ phase: 'available', newVersion: i.version }))
    autoUpdater.on('update-not-available', () => push({ phase: 'idle' }))
    autoUpdater.on('download-progress', (p) =>
      push({ phase: 'downloading', percent: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (i) => push({ phase: 'ready', newVersion: i.version }))
    // 업데이트 서버가 없거나 못 읽어도 **앱은 계속 돌아야 한다** — 조용히 idle로 두지 않고
    // 사유를 남긴다(설정 화면에서만 보인다. 배너로 띄우면 매번 놀란다)
    autoUpdater.on('error', (e) => push({ phase: 'error', error: String(e).slice(0, 200) }))
  }

  const check = async (): Promise<UpdateStatus> => {
    if (!enabled) return status
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      push({ phase: 'error', error: String(e).slice(0, 200) })
    }
    return status
  }

  const start = (): void => {
    if (!enabled) return
    // 켜자마자 부르지 않는다 — 시작이 느려 보이고, 첫 화면이 뜨기 전 네트워크를 쓴다
    setTimeout(() => void check(), 20_000)
    setInterval(() => void check(), SIX_HOURS)
  }

  const install = (): void => {
    if (!enabled || status.phase !== 'ready') return
    autoUpdater.quitAndInstall()
  }

  return { info: (): UpdateStatus => status, check, start, install }
}
