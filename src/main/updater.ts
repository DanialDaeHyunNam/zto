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
import { existsSync } from 'fs'
import { join } from 'path'

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

// 확인은 자주, 요청은 적게. 6시간이면 하루 종일 켜둔 세션이 옛 버전인 줄도 모르고 산다 —
// 사이드바에 배지를 다는 순간 "배지가 언제 뜨느냐"가 곧 신뢰도라 30분으로 당긴다.
// 대신 **포커스 복귀 시에도 확인**한다: 잠자기에서 깬 노트북은 interval이 밀려 있다.
const CHECK_EVERY = 30 * 60 * 1000
// 창을 왔다갔다 할 때마다 릴리스 서버를 두드리지 않게 하는 최소 간격
const FOCUS_MIN_GAP = 10 * 60 * 1000

export function createUpdater(getWindow: () => BrowserWindow | null) {
  let status: UpdateStatus = { phase: 'idle', version: app.getVersion() }
  // 패키징 안 된 앱에선 electron-updater가 동작하지 않고, 패키징됐어도 업데이트 채널이
  // 안 구워진 빌드(소스 빌드 — publish 설정은 CI만 주입)면 확인할 곳이 없다.
  // 둘 다 "오류"가 아니라 "비활성"이다 — 소스 빌더의 설정 화면에 오류를 띄우면 고장으로 보인다
  const enabled = app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))

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

  let lastCheck = 0
  let started = false

  const check = async (): Promise<UpdateStatus> => {
    if (!enabled) return status
    lastCheck = Date.now()
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      push({ phase: 'error', error: String(e).slice(0, 200) })
    }
    return status
  }

  // 이미 받아놨거나 받는 중이면 또 확인하지 않는다 — 사이드바 배지가
  // "준비됨"에서 "확인 중"으로 되돌아가면 눌러야 할 순간에 버튼이 사라진다
  const busy = (): boolean => status.phase === 'downloading' || status.phase === 'ready'
  const checkIfIdle = (): void => {
    if (!busy()) void check()
  }

  const start = (): void => {
    // 배지 UI는 릴리스가 나야만 볼 수 있는 상태다 — 그래서 **dev에서만** 가짜 상태를 밀어준다
    // (`ZTO_FAKE_UPDATE=9.9.9 npm run dev`). 패키징 빌드에선 절대 열리지 않는다
    if (!app.isPackaged && process.env.ZTO_FAKE_UPDATE) {
      setTimeout(
        () => push({ phase: 'ready', newVersion: process.env.ZTO_FAKE_UPDATE, disabled: false }),
        1500
      )
      return
    }
    if (!enabled || started) return // 창 재생성(macOS activate) 때 타이머가 겹치지 않게
    started = true
    // 켜자마자 부르지 않는다 — 시작이 느려 보이고, 첫 화면이 뜨기 전 네트워크를 쓴다
    setTimeout(checkIfIdle, 20_000)
    setInterval(checkIfIdle, CHECK_EVERY)
    const w = getWindow()
    w?.on('focus', () => {
      if (Date.now() - lastCheck >= FOCUS_MIN_GAP) checkIfIdle()
    })
  }

  const install = (): void => {
    if (!enabled || status.phase !== 'ready') return
    autoUpdater.quitAndInstall()
  }

  return { info: (): UpdateStatus => status, check, start, install }
}
