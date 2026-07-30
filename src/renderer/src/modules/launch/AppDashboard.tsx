import { useCallback, useEffect, useState } from 'react'
import type {
  ApplyResult,
  DashApple,
  DashboardData,
  DashGoogle,
  DashImageSet,
  EditPlatform,
  EditSection,
  LiveIapProduct,
  MetaListing,
  PendingEdit,
  QuestionnaireMeta,
  RunResult,
  SheetIapInfo,
  SheetSummary,
  StoreSnapshotEntry
} from '../../../../shared/launch-types'
import type { DataSafetyDoc } from '../../../../shared/console-types'
import { useI18n } from '../../i18n'
import type { Messages } from '../../i18n/en'
import ContentSurveyWizard from './ContentSurveyWizard'
import { useBrowserOverlay } from '../../browser-overlay'

// 플랫폼별 앱 콘텐츠 설문 (콘솔 전용 설정을 메움)
// 설문별 콘솔 딥링크 — Play는 콘솔 홈, ASC는 appId로 런타임 구성(앱 개인정보/연령 등급 페이지 구분)
function surveyConsoleUrl(
  id: string,
  surveys: QuestionnaireMeta[],
  data: DashboardData | null
): string | undefined {
  const q = surveys.find((s) => s.id === id)
  if (!q) return undefined
  if (q.platform === 'android') return PLAY_CONSOLE_URL
  const appId = data?.apple?.appId
  if (!appId) return undefined
  const base = `https://appstoreconnect.apple.com/apps/${appId}`
  return id === 'asc-app-privacy' ? `${base}/distribution/appprivacy` : `${base}/distribution/info`
}

// §4.5 앱 대시보드 (P1 읽기 전용) — 플랫폼 탭(Android|iOS) + 전체 폭 상태 트리.
// 불은 수동 체크가 아니라 스토어 pull로 자동 점등. API가 없는 노드만 🟡 + 콘솔 링크.
// 마지막 pull은 저장돼 있어 진입 즉시 뜨고, 스토어 조회는 [새로고침]으로만 (2026-07-22 Dan).

type Tone = 'ok' | 'warn' | 'off'
type Light = 'g' | 'y' | 'o'
type Platform = 'android' | 'ios'

const PLAY_CONSOLE_URL = 'https://play.google.com/console'
const ascAppUrl = (appId: string): string =>
  `https://appstoreconnect.apple.com/apps/${appId}/distribution`

// 트랙·상태 라벨은 스토어 개념 용어라 번역하지 않는다
const playTrackLabel = (track: string): string =>
  track === 'production'
    ? 'prod'
    : track === 'beta'
      ? 'open'
      : track === 'internal'
        ? 'internal'
        : 'closed'

const playStatusTone = (status: string): Tone =>
  status === 'completed' ? 'ok' : status === 'halted' ? 'off' : 'warn'

function ascStateChip(state: string): { label: string; tone: Tone } {
  const label = state.toLowerCase().replace(/_/g, ' ')
  if (state === 'READY_FOR_SALE') return { label: 'prod', tone: 'ok' }
  if (state === 'REPLACED_WITH_NEW_VERSION') return { label: 'outdated', tone: 'off' }
  if (['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REMOVED_FROM_SALE', 'REMOVED_FROM_SALE'].includes(state))
    return { label, tone: 'off' }
  return { label, tone: 'warn' } // in review · waiting · pending · rejected 계열 — 손이 갈 수 있는 상태
}

const iapStateTone = (state: string): Tone =>
  state.toUpperCase().includes('APPROVED') || state === 'ACTIVE' ? 'ok' : 'warn'

const playRank = (t: string): number =>
  t === 'production' ? 0 : t === 'beta' ? 1 : t === 'internal' ? 3 : 2

// 버전 잠금 해제용 제안 버전 — 기존 최고 버전의 패치를 +1 (애플은 라이브보다 높은 번호만 받음)
function nextVersion(versions: string[]): string {
  const parsed = versions
    .map((v) => v.split('.').map((n) => parseInt(n, 10) || 0))
    .filter((p) => p.length > 0)
  parsed.sort((a, b) => b[0] - a[0] || (b[1] ?? 0) - (a[1] ?? 0) || (b[2] ?? 0) - (a[2] ?? 0))
  const top = parsed[0]
  if (!top) return '1.0.1'
  const [maj = 1, min = 0, pat = 0] = top
  return `${maj}.${min}.${pat + 1}`
}

// 'ko' 같은 언어 서브태그로 로케일 항목 찾기 (Play ko-KR ↔ ASC ko 매칭)
const pickByLang = <T extends { locale: string }>(arr: T[], sub: string): T | undefined =>
  arr.find((x) => x.locale.toLowerCase().startsWith(sub))

const repNoteText = (notes: { locale: string; text: string }[]): string =>
  (notes.find((n) => n.locale.toLowerCase().startsWith('ko')) ?? notes[0])?.text ?? ''

// 플랫폼 요약 칩 — "지금 어디까지 갔나" (최상위 트랙/최신 버전 상태)
function playSummary(g: DashGoogle): { label: string; tone: Tone } | null {
  const has = (pick: (track: string) => boolean): boolean =>
    g.releases.some((r) => pick(r.track) && r.status === 'completed')
  if (has((t) => t === 'production')) return { label: 'prod', tone: 'ok' }
  if (has((t) => t === 'beta')) return { label: 'open', tone: 'warn' }
  if (has((t) => !['internal', 'beta', 'production'].includes(t)))
    return { label: 'closed', tone: 'warn' }
  if (g.releases.length > 0) return { label: 'internal', tone: 'off' }
  return null
}

function Chip({ label, tone }: { label: string; tone: Tone }): React.JSX.Element {
  return <span className={`status-chip ${tone}`}>{label}</span>
}

function Node({
  light,
  label,
  url,
  children
}: {
  light: Light
  label: string
  url?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="dash-node">
      <span className={`dash-dot ${light}`} />
      <span className="dash-lbl">{label}</span>
      <span className="dash-val">{children}</span>
      {url && (
        <button className="dash-go" onClick={() => window.zto.launch.openExternal(url)}>
          ↗
        </button>
      )}
    </div>
  )
}

// 스토어 설정(등급·데이터 보안·개인정보 등)은 대부분 read API가 없고, 있어도 우리가
// 수정 동기화를 하지 않기로 했다(2026-07-30 Dan). 그래서 ZTO가 할 일은 **어디서 보는지**를
// 정확히 알려주는 것까지다. 콘솔 메뉴 경로를 그대로 적는 이유는, 링크만 주면 열린 화면에서
// 또 헤매기 때문 — 오늘 자동화가 사이드바 9번째 섹션을 못 찾아 다섯 번 헤맨 것과 같은 문제다.
function WhereToCheck({ where, items }: { where: string; items: string }): React.JSX.Element {
  const { m } = useI18n()
  return (
    <div className="dash-where">
      <span className="dash-where-lbl">{m.launch.dashWhereLabel}</span>
      <span className="dash-where-path">{where}</span>
      <span className="dash-where-items">{items}</span>
    </div>
  )
}

// 자산 교체 (ROADMAP #3) — Play는 이미지 조작이 메타와 **같은 edit 안**에서 일어나 commit 하나로
// 원자적으로 반영된다. 그래서 별도 발사 버튼 없이 기존 "수정 적용하기" 흐름에 그대로 얹힌다.
//
// 개별 추가·삭제가 아니라 **세트 통째 교체**인 이유: Play 스크린샷은 순서 = 업로드 순서라
// 세트 교체가 순서 변경까지 공짜로 해결하고, 개별 삭제에 필요한 imageId 추적이 읽기·스냅샷
// 타입까지 번지는 걸 막는다. 실제로도 스크린샷은 한 장씩 고치기보다 새 세트로 갈아끼운다.
// 종류별 교체를 한 곳에서 관리한다. 액션은 썸네일 묶음의 **뱃지 옆 아이콘 버튼**으로 나가고,
// 고른 결과·오류만 아래에 붙는다 — 아래에 종류별 행을 다시 나열하면 라벨이 두 번이다.
function AssetEditor({
  locale,
  sets,
  edits,
  label,
  onStage,
  onOpen
}: {
  locale: string
  sets: DashImageSet[]
  edits: Record<string, PendingEdit>
  label: (s: DashImageSet) => string
  onStage: (e: PendingEdit) => void
  onOpen: (urls: string[], idx: number) => void
}): React.JSX.Element {
  const { m } = useI18n()
  const [err, setErr] = useState('')
  const [picks, setPicks] = useState<
    Record<string, { name: string; preview: string; width: number; height: number }[]>
  >({})

  const idOf = (type: string): string => `android:assets:${locale}:${type}`

  const pick = async (type: string): Promise<void> => {
    setErr('')
    const r = await window.zto.launch.pickAssets(type)
    if (r.canceled) return
    if (!r.ok) {
      // 규격 위반은 main이 "512×512여야 하는데 1024×1024"까지 만들어 준다 — 그대로 보여준다
      setErr(r.error ?? '')
      return
    }
    setPicks((p) => ({ ...p, [type]: r.files }))
    onStage({
      id: idOf(type),
      platform: 'android',
      section: 'assets',
      field: type,
      locale,
      label: `${assetTypeLabel(m, type)} · ${locale}`,
      oldValue: '',
      newValue: r.files.map((f) => f.path).join('\n')
    })
  }

  const revert = (type: string): void => {
    setPicks((p) => {
      const n = { ...p }
      delete n[type]
      return n
    })
    setErr('')
    // oldValue와 같아지면 stage가 대기 목록에서 지운다
    onStage({
      id: idOf(type),
      platform: 'android',
      section: 'assets',
      field: type,
      locale,
      label: assetTypeLabel(m, type),
      oldValue: '',
      newValue: ''
    })
  }

  const staged = Object.keys(picks).filter((t) => edits[idOf(t)])

  return (
    <>
      <AssetStrip
        sets={sets}
        label={label}
        onOpen={onOpen}
        action={(s) => (
          <button
            className={`asset-swap ${edits[idOf(s.type)] ? 'on' : ''}`}
            onClick={() => pick(s.type)}
            title={m.launch.assetReplace}
          >
            ⇄
          </button>
        )}
      />
      {staged.map((t) => (
        <div key={t} className="asset-staged">
          <span className="asset-staged-lbl">
            {assetTypeLabel(m, t)} · {m.launch.assetStaged.replace('{n}', String(picks[t].length))}
          </span>
          <div className="asset-picks">
            {picks[t].map((p, i) => (
              <figure key={i}>
                {p.preview && <img src={p.preview} alt="" />}
                <figcaption>
                  {p.width}×{p.height}
                </figcaption>
              </figure>
            ))}
          </div>
          <button className="ghost-btn mini" onClick={() => revert(t)}>
            {m.launch.assetRevert}
          </button>
        </div>
      ))}
      {err && <div className="asset-edit-err">{err}</div>}
    </>
  )
}

function LocaleChips({ locales }: { locales: string[] }): React.JSX.Element {
  return (
    <span className="loc-chips">
      {locales.map((l) => (
        <i key={l}>{l}</i>
      ))}
    </span>
  )
}

const playAssetLabel = (m: Messages, s: DashImageSet): string =>
  s.type === 'icon'
    ? m.launch.dashAssetIcon
    : s.type === 'featureGraphic'
      ? m.launch.dashAssetFeature
      : `${m.launch.dashAssetPhoneShots} ${m.launch.dashShotCount.replace('{n}', String(s.urls.length))}`

// 자산 종류 이름만 (장수 없이) — 편집 행은 현재 장수를 따로 보여주므로 라벨에 섞으면 중복이다
const assetTypeLabel = (m: Messages, type: string): string =>
  type === 'icon'
    ? m.launch.dashAssetIcon
    : type === 'featureGraphic'
      ? m.launch.dashAssetFeature
      : m.launch.dashAssetPhoneShots

const ascShotLabel = (m: Messages, s: DashImageSet): string =>
  `${s.type.replace(/^APP_/, '').replace(/_/g, ' ').toLowerCase()} ${m.launch.dashShotCount.replace('{n}', String(s.urls.length))}`

// ---------- 기록 보기 — 스냅샷 이력에서 해당 섹션만 최신순으로, 연속 동일 내용은 기간으로 접는다 ----------
function HistoryLog({
  file,
  render
}: {
  file: string
  render: (e: StoreSnapshotEntry) => string | null
}): React.JSX.Element {
  const { m } = useI18n()
  const [entries, setEntries] = useState<StoreSnapshotEntry[] | null>(null)

  useEffect(() => {
    window.zto.launch.snapshots(file).then(setEntries)
  }, [file])

  if (!entries) return <div className="dash-hist">{m.launch.checking}</div>
  const d = (s: string): string =>
    new Date(s).toLocaleString(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  const rows: { from: string; to: string; text: string }[] = []
  for (const e of entries) {
    // entries는 최신순 — 같은 내용이 이어지면 기간을 과거로 확장
    const text = render(e)
    if (text === null) continue
    const last = rows[rows.length - 1]
    if (last && last.text === text) last.from = e.createdAt
    else rows.push({ from: e.createdAt, to: e.confirmedAt, text })
  }
  if (rows.length === 0) return <div className="dash-hist">{m.launch.historyEmpty}</div>
  return (
    <div className="dash-hist-log">
      {rows.map((r, i) => (
        <div key={i} className="dash-hist-row">
          <span className="dash-hist-time">
            {d(r.from)} ~ {d(r.to)}
          </span>
          <span className="dash-hist-text">{r.text}</span>
        </div>
      ))}
    </div>
  )
}

function HistoryToggle({
  file,
  render
}: {
  file: string
  render: (e: StoreSnapshotEntry) => string | null
}): React.JSX.Element {
  const { m } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="ghost-btn mini" onClick={() => setOpen((v) => !v)}>
        {open ? m.launch.hideHistory : m.launch.viewHistory}
      </button>
      {open && <HistoryLog file={file} render={render} />}
    </>
  )
}

const summarizeIap = (iap: LiveIapProduct[]): string =>
  iap
    .map((p) => `${p.id} ${p.state.toLowerCase().replace(/_/g, ' ')}${p.priceLabel ? ` · ${p.priceLabel}` : ''}`)
    .join('  |  ') || '—'

const summarizeMeta = (meta: MetaListing[]): string =>
  meta.map((l) => [l.locale, l.title, l.short].filter(Boolean).join(' · ')).join('  |  ') || '—'

// ---------- 자산 썸네일 + 라이트박스 ----------
// 썸네일을 **종류별로 묶고 라벨을 단다.** 예전엔 아이콘·피처그래픽·스크린샷을 한 줄에 죽
// 늘어놓아서, 아래 교체 행의 '아이콘'이 위쪽 어느 칸인지 눈으로 이어지지 않았다(Dan 2026-07-30).
// 교체는 세트 단위이므로 화면에서도 세트가 보여야 무엇을 바꾸는지 알 수 있다.
// 라이트박스 인덱스는 전체 기준을 유지한다 — 좌우로 넘기면 종류를 가로질러 계속 넘어간다.
function AssetStrip({
  sets,
  label,
  action,
  onOpen
}: {
  sets: DashImageSet[]
  label: (s: DashImageSet) => string
  // 교체 액션은 **뱃지 옆**에 붙인다 — 뱃지가 이미 "이 영역이 아이콘"이라고 말하고 있으므로
  // 아래에 같은 이름의 행을 다시 나열하면 라벨이 두 번이다(Dan 2026-07-30).
  // 렌더 프롭으로 받는 이유: iOS는 아직 편집 경로가 없어 액션이 없다(ASC는 3단계 업로드).
  action?: (s: DashImageSet) => React.ReactNode
  onOpen: (urls: string[], idx: number) => void
}): React.JSX.Element {
  const all = sets.flatMap((s) => s.urls)
  let base = 0
  return (
    <div className="dash-asset-groups">
      {sets.map((s) => {
        const start = base
        base += s.urls.length
        return (
          <div className="dash-asset-group" key={s.type}>
            <span className="dash-asset-head">
              <span className="dash-asset-tag">{label(s)}</span>
              {action?.(s)}
            </span>
            <div className="dash-shots">
              {s.urls.map((u, i) => (
                <img
                  key={`${s.type}-${i}`}
                  src={u}
                  // alt를 비운다 — 로드 실패 시 브라우저가 alt 텍스트와 깨진 아이콘을 그리는데,
                  // 그게 화면에 '부재'를 크게 써 붙이는 꼴이라 디자인 원칙에 어긋난다(CLAUDE.md).
                  alt=""
                  loading="lazy"
                  // 실패한 칸은 조용한 빈 타일로 남긴다
                  onError={(e) => e.currentTarget.classList.add('shot-failed')}
                  onClick={() => onOpen(all, start + i)}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Lightbox({
  urls,
  idx,
  onClose,
  onNav
}: {
  urls: string[]
  idx: number
  onClose: () => void
  onNav: (next: number) => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onNav((idx - 1 + urls.length) % urls.length)
      if (e.key === 'ArrowRight') onNav((idx + 1) % urls.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [idx, urls.length, onClose, onNav])

  return (
    <div className="lightbox" onClick={onClose}>
      {urls.length > 1 && (
        <button
          className="lb-nav prev"
          onClick={(e) => {
            e.stopPropagation()
            onNav((idx - 1 + urls.length) % urls.length)
          }}
        >
          ‹
        </button>
      )}
      <img src={urls[idx]} alt="" onClick={(e) => e.stopPropagation()} />
      {urls.length > 1 && (
        <button
          className="lb-nav next"
          onClick={(e) => {
            e.stopPropagation()
            onNav((idx + 1) % urls.length)
          }}
        >
          ›
        </button>
      )}
      <div className="lb-count">
        {idx + 1} / {urls.length}
      </div>
      <button className="lb-close" onClick={onClose}>
        ✕
      </button>
    </div>
  )
}

// ---------- IAP ----------
function IapSub({ items }: { items: LiveIapProduct[] }): React.JSX.Element {
  return (
    <div className="dash-sub">
      {items.map((p) => (
        <div key={p.id} className="dash-sub-row">
          <code>{p.id}</code>
          <span className="dash-sub-title">{p.title}</span>
          {p.priceLabel && <span className="dash-price">{p.priceLabel}</span>}
          <Chip label={p.state.toLowerCase().replace(/_/g, ' ')} tone={iapStateTone(p.state)} />
        </div>
      ))}
    </div>
  )
}

type IapAction = 'upsert' | 'activate'

// 시트 상품 반영 — IAP 노드에 매달린 실행 액션 (비가역: 2단 컨펌, SPEC §3)
function SheetIapApply({ file }: { file: string }): React.JSX.Element | null {
  const { m } = useI18n()
  const [info, setInfo] = useState<SheetIapInfo | null>(null)
  const [runState, setRunState] = useState<Record<IapAction, 'idle' | 'confirm' | 'running'>>({
    upsert: 'idle',
    activate: 'idle'
  })
  const [results, setResults] = useState<Partial<Record<IapAction, RunResult>>>({})

  useEffect(() => {
    window.zto.launch.sheetIap(file).then(setInfo)
  }, [file])

  if (!info || info.products.length === 0) return null

  const run = (action: IapAction): void => {
    if (runState[action] === 'running') return
    if (runState[action] === 'idle') {
      setRunState((s) => ({ ...s, [action]: 'confirm' }))
      setTimeout(
        () => setRunState((s) => (s[action] === 'confirm' ? { ...s, [action]: 'idle' } : s)),
        4000
      )
      return
    }
    setRunState((s) => ({ ...s, [action]: 'running' }))
    window.zto.launch.runIap(file, action).then((r) => {
      setResults((prev) => ({ ...prev, [action]: r }))
      setRunState((s) => ({ ...s, [action]: 'idle' }))
    })
  }

  const actionBtn = (action: IapAction, label: string): React.JSX.Element => {
    const state = runState[action]
    const result = results[action]
    return (
      <div className="run-block">
        <div className="run-row">
          <button
            className={`choice tiny ${state === 'confirm' ? 'danger-confirm' : ''}`}
            disabled={state === 'running'}
            onClick={() => run(action)}
          >
            {state === 'running' ? m.launch.running : state === 'confirm' ? m.launch.reallyRun : label}
          </button>
          {result && (
            <span className={`status-chip ${result.ok ? 'ok' : 'warn'}`}>
              {result.ok ? m.launch.resultOk : m.launch.resultFail}
            </span>
          )}
        </div>
        {result && (
          <pre className="run-output">
            {typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output, null, 2)}
            {result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div className="dash-sub">
      <div className="dash-hist">{m.launch.stepApply}</div>
      {info.products.map((p) => (
        <div key={p.productId} className="dash-sub-row">
          <code>{p.productId}</code>
          <span className="dash-sub-title">{p.title}</span>
          <span className="dash-price">{p.priceLabel}</span>
        </div>
      ))}
      {actionBtn('upsert', m.launch.runUpsert)}
      {actionBtn('activate', m.launch.runActivate)}
    </div>
  )
}

// 자격증명 없음/조회 실패 — API 노드에 상태를 켜고, 미보유면 발급 가이드를 바로 매단다
function PlatformError({ error, store }: { error?: string; store: 'play' | 'asc' }): React.JSX.Element {
  const { m } = useI18n()
  const noKey = error === 'no-key'
  const guide =
    store === 'play'
      ? {
          intro: m.launch.googleSaGuideIntro,
          steps: m.launch.googleSaSteps,
          label: m.launch.openPlayConsole,
          url: 'https://play.google.com/console'
        }
      : {
          intro: m.launch.ascGuideIntro,
          steps: m.launch.ascSteps,
          label: m.launch.openAscIntegrations,
          url: 'https://appstoreconnect.apple.com/access/integrations/api'
        }
  return (
    <>
      <Node light={noKey ? 'o' : 'y'} label={m.launch.dashNodeApi}>
        {noKey ? m.launch.liveNoCreds : m.launch.liveError.replace('{d}', error ?? '')}
      </Node>
      {noKey && (
        <div className="guide no-indent">
          <p>{guide.intro}</p>
          <ol>
            {guide.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <button className="link-btn" onClick={() => window.zto.launch.openExternal(guide.url)}>
            {guide.label}
          </button>
        </div>
      )}
    </>
  )
}

// 로케일별 메타 상세 (타이틀·짧은 설명) + 전체 보기·기록 보기
function MetaSub({
  rows,
  file,
  render,
  onOpenFull
}: {
  rows: MetaListing[]
  file: string
  render: (e: StoreSnapshotEntry) => string | null
  onOpenFull: () => void
}): React.JSX.Element {
  const { m } = useI18n()
  return (
    <div className="dash-sub">
      {rows.map((l) => (
        <div key={l.locale} className="dash-sub-row">
          <span className="loc-chips">
            <i>{l.locale}</i>
          </span>
          <span className="dash-meta-title">{l.title}</span>
          <span className="dash-meta-short">{l.short}</span>
        </div>
      ))}
      <div>
        <button className="ghost-btn mini" onClick={onOpenFull}>
          {m.launch.dashMetaOpen}
        </button>
        <HistoryToggle file={file} render={render} />
      </div>
    </div>
  )
}

// 메타 전체 보기 — 언어 탭 + iOS/Android 나란히, 글자 수 표시 (example 허브 Store Status 참고)
// 편집 가능한 메타 필드 — 스토어 값 대비 바뀌면 대기 diff에 쌓인다 (controlled by edits)
function MetaField({
  platform,
  platLabel,
  section,
  locale,
  fieldKey,
  label,
  storeValue,
  multiline,
  edits,
  stage
}: {
  platform: EditPlatform
  platLabel: string
  section: EditSection
  locale: string
  fieldKey: string
  label: string
  storeValue: string
  multiline?: boolean
  edits: Record<string, PendingEdit>
  stage: (e: PendingEdit) => void
}): React.JSX.Element {
  const { m } = useI18n()
  const id = `${platform}:${section}:${locale}:${fieldKey}`
  const staged = edits[id]
  const value = staged ? staged.newValue : storeValue
  const changed = staged != null
  const onChange = (v: string): void =>
    stage({
      id,
      platform,
      section,
      field: fieldKey,
      locale,
      label: `${platLabel} · ${label}${locale ? ` (${locale})` : ''}`,
      oldValue: storeValue,
      newValue: v
    })

  return (
    <div className={`meta-field${changed ? ' changed' : ''}`}>
      <div className="meta-field-label">
        {label}
        <span className="meta-chars">{m.launch.dashChars.replace('{n}', String(value.length))}</span>
        {changed && (
          <button className="meta-revert" onClick={() => onChange(storeValue)}>
            {m.launch.dashRevertField}
          </button>
        )}
      </div>
      {multiline ? (
        <textarea
          className="email-input meta-edit-area"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="email-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

function MetaModal({
  data,
  edits,
  stage,
  onClose
}: {
  data: DashboardData
  edits: Record<string, PendingEdit>
  stage: (e: PendingEdit) => void
  onClose: () => void
}): React.JSX.Element {
  const { m } = useI18n()
  const g = data.google
  const a = data.apple
  const subs = [
    ...new Set([
      ...(g?.listings ?? []).map((l) => l.locale.split('-')[0].toLowerCase()),
      ...(a?.meta ?? []).map((l) => l.locale.split('-')[0].toLowerCase())
    ])
  ].sort((x, y) => (x === 'ko' ? -1 : y === 'ko' ? 1 : x.localeCompare(y)))
  const [lang, setLang] = useState(subs[0] ?? '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const gl = g ? pickByLang(g.listings, lang) : undefined
  const al = a ? pickByLang(a.meta, lang) : undefined
  const aNote = a ? pickByLang(a.releaseNotes, lang)?.text : undefined
  const gRelease = g
    ? [...g.releases].sort((x, y) => playRank(x.track) - playRank(y.track)).find((r) => r.notes.length > 0)
    : undefined
  const gNote = gRelease ? pickByLang(gRelease.notes, lang)?.text : undefined

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="meta-modal" onClick={(e) => e.stopPropagation()}>
        <div className="meta-modal-head">
          <strong>{m.launch.dashMetaTitle}</strong>
          <div className="app-picker">
            {subs.map((s) => (
              <button
                key={s}
                className={`app-chip ${s === lang ? 'active' : ''}`}
                onClick={() => setLang(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="meta-cols">
          {gl && (
            <div className="meta-col">
              <div className="meta-col-head">{m.launch.dashAndroid}</div>
              <MetaField platform="android" platLabel={m.launch.dashAndroid} section="meta" locale={gl.locale} fieldKey="title" label={m.launch.dashFieldName} storeValue={gl.title} edits={edits} stage={stage} />
              <MetaField platform="android" platLabel={m.launch.dashAndroid} section="meta" locale={gl.locale} fieldKey="short" label={m.launch.dashFieldShort} storeValue={gl.short} edits={edits} stage={stage} />
              <MetaField platform="android" platLabel={m.launch.dashAndroid} section="meta" locale={gl.locale} fieldKey="full" label={m.launch.dashFieldFull} storeValue={gl.full} multiline edits={edits} stage={stage} />
              <MetaField platform="android" platLabel={m.launch.dashAndroid} section="releaseNotes" locale={gl.locale} fieldKey="whatsNew" label={m.launch.dashFieldNotes} storeValue={gNote ?? ''} multiline edits={edits} stage={stage} />
            </div>
          )}
          {al && (
            <div className="meta-col">
              <div className="meta-col-head">{m.launch.dashIos}</div>
              <MetaField platform="ios" platLabel={m.launch.dashIos} section="meta" locale={al.locale} fieldKey="name" label={m.launch.dashFieldName} storeValue={al.title} edits={edits} stage={stage} />
              <MetaField platform="ios" platLabel={m.launch.dashIos} section="meta" locale={al.locale} fieldKey="subtitle" label={m.launch.dashFieldSubtitle} storeValue={al.short} edits={edits} stage={stage} />
              <MetaField platform="ios" platLabel={m.launch.dashIos} section="meta" locale={al.locale} fieldKey="promotionalText" label={m.launch.dashFieldPromo} storeValue={al.promo} edits={edits} stage={stage} />
              <MetaField platform="ios" platLabel={m.launch.dashIos} section="meta" locale={al.locale} fieldKey="keywords" label={m.launch.dashFieldKeywords} storeValue={al.keywords} edits={edits} stage={stage} />
              <MetaField platform="ios" platLabel={m.launch.dashIos} section="meta" locale={al.locale} fieldKey="description" label={m.launch.dashFieldFull} storeValue={al.full} multiline edits={edits} stage={stage} />
              <MetaField platform="ios" platLabel={m.launch.dashIos} section="releaseNotes" locale={al.locale} fieldKey="whatsNew" label={m.launch.dashFieldNotes} storeValue={aNote ?? ''} multiline edits={edits} stage={stage} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// 대기 diff 적용 바 + 결과 패널 — 모든 편집 섹션이 공유 (지금은 메타, 이후 IAP·자산)
function ApplyBar({
  file,
  edits,
  onApplied,
  onReset,
  linkFor,
  suggestedVersion
}: {
  file: string
  edits: Record<string, PendingEdit>
  onApplied: (okIds: string[]) => void
  onReset: () => void
  linkFor: (e: PendingEdit) => string | undefined // 실패 항목을 직접 고칠 콘솔 딥링크
  suggestedVersion: string // 버전 잠금 해제용 제안 버전 번호 (라이브보다 높게)
}): React.JSX.Element | null {
  const { m } = useI18n()
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'running'>('idle')
  const [results, setResults] = useState<ApplyResult[] | null>(null)
  const [verInput, setVerInput] = useState(suggestedVersion)
  const [verBusy, setVerBusy] = useState(false)
  const [verError, setVerError] = useState<string | null>(null)
  const pending = Object.values(edits)

  if (pending.length === 0 && !results) return null

  // 버전 잠금으로 실패한 iOS 항목들 (라이브 이름 등은 새 버전이 있어야 편집 가능)
  const versionLocked = (results ?? []).filter(
    (r) =>
      !r.ok &&
      edits[r.id]?.platform === 'ios' &&
      /current state|editable version/i.test(r.message)
  )

  // 새 버전 생성(컨펌) → 편집 가능해진 뒤 iOS 대기 편집 재반영
  const createVersionAndApply = async (): Promise<void> => {
    setVerBusy(true)
    setVerError(null)
    const cv = await window.zto.launch.createIosVersion(file, verInput.trim())
    if (!cv.ok) {
      setVerBusy(false)
      setVerError(cv.error ?? 'failed')
      return
    }
    const iosPending = pending.filter((e) => e.platform === 'ios')
    const newRes = await window.zto.launch.applyEdits(file, iosPending)
    setResults((prev) => [
      ...(prev ?? []).filter((r) => edits[r.id]?.platform !== 'ios'),
      ...newRes
    ])
    onApplied(newRes.filter((r) => r.ok).map((r) => r.id))
    setVerBusy(false)
  }

  const run = (): void => {
    if (phase === 'idle') {
      setPhase('confirm')
      return
    }
    if (phase !== 'confirm') return
    setPhase('running')
    window.zto.launch.applyEdits(file, pending).then((res) => {
      setResults(res)
      setPhase('idle')
      onApplied(res.filter((r) => r.ok).map((r) => r.id))
    })
  }

  return (
    <>
      {results && (
        <div className="lightbox" onClick={() => setResults(null)}>
          <div className="result-panel" onClick={(e) => e.stopPropagation()}>
            <div className="result-head">
              <strong>{m.launch.applyResultTitle}</strong>
              <button className="modal-close" onClick={() => setResults(null)}>
                ✕
              </button>
            </div>
            <div className="result-list">
              {results.map((r) => {
                const e = pending.find((p) => p.id === r.id)
                const url = !r.ok && e ? linkFor(e) : undefined
                return (
                  <div key={r.id} className="result-row">
                    <span className={`dash-dot ${r.ok ? 'g' : 'y'}`} />
                    <span className="result-label">{e?.label ?? r.id}</span>
                    <span className="result-msg">{r.message}</span>
                    {url && (
                      <button
                        className="result-fix"
                        onClick={() => window.zto.launch.openExternal(url)}
                      >
                        {m.launch.applyFixInConsole}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            {versionLocked.length > 0 && (
              <div className="version-fix">
                <p className="version-fix-note">{m.launch.versionNeeded}</p>
                <div className="version-fix-row">
                  <input
                    className="email-input version-input"
                    value={verInput}
                    onChange={(e) => setVerInput(e.target.value)}
                    placeholder={m.launch.versionLabel}
                  />
                  <button
                    className="choice small active"
                    onClick={createVersionAndApply}
                    disabled={verBusy || !verInput.trim()}
                  >
                    {verBusy ? m.launch.running : m.launch.createVersionApply}
                  </button>
                </div>
                {verError && <p className="version-fix-err">{verError}</p>}
              </div>
            )}
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <div className="apply-bar">
          <span className="apply-count">
            {m.launch.applyPending.replace('{n}', String(pending.length))}
          </span>
          {phase === 'confirm' ? (
            <>
              <span className="apply-warn">{m.launch.applyConfirm}</span>
              <button className="choice small" onClick={() => setPhase('idle')}>
                {m.accounts.cancel}
              </button>
              <button className="choice small danger-confirm" onClick={run}>
                {m.launch.applyRun}
              </button>
            </>
          ) : (
            <>
              <button className="ghost-btn" onClick={onReset} disabled={phase === 'running'}>
                {m.launch.applyRevertAll}
              </button>
              <button className="choice small active" onClick={run} disabled={phase === 'running'}>
                {phase === 'running' ? m.launch.running : m.launch.applyBtn}
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}

// 설정 노드 아래 설문 버튼들 — 플랫폼별 여러 설문(등급·데이터안전·타깃연령·앱개인정보)을 라벨과 완료뱃지로
type SurveyItem = { id: string; title: string; done: boolean }
function SurveyButtons({
  surveys,
  onOpen
}: {
  surveys: SurveyItem[]
  onOpen: (id: string) => void
}): React.JSX.Element | null {
  const { m } = useI18n()
  if (surveys.length === 0) return null
  return (
    <div className="dash-sub">
      <div className="survey-btns">
        {surveys.map((s) => (
          <button key={s.id} className="ghost-btn mini" onClick={() => onOpen(s.id)}>
            {s.title}
            {s.done && <span className="survey-badge">✓ {m.launch.surveyDone}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

// 데이터 안전 — 콘솔에서 CSV로 가져오기. 사용자는 "언제 무엇을" 할지 몰라도 되게,
// 로그인 확인부터 파싱까지 ZTO가 한 번에 한다(Dan 2026-07-29). 진행 단계를 보여주는 이유는
// 20초간 조용하면 고장으로 보이기 때문. 실패해도 막다른 길이 아니라 [폼 열기]로 넘긴다.
function DataSafetyPull({ file }: { file: string }): React.JSX.Element {
  const { m } = useI18n()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [failed, setFailed] = useState(false)
  const [formUrl, setFormUrl] = useState('')
  // 가져온 결과는 화면에 남아야 한다 — 성공을 로그로만 확인할 수 있으면 제품이 아니다
  const [doc, setDoc] = useState<(DataSafetyDoc & { at?: string }) | null>(null)
  const [showAnswers, setShowAnswers] = useState(false)
  const { open, close, setGuide } = useBrowserOverlay()

  const stepText = (step: string, detail?: string): string =>
    ({
      opening: m.launch.dsStepOpening,
      'login-required': m.launch.dsStepLogin,
      'needs-user': m.launch.dsStepNeedsUser,
      'finding-app': m.launch.dsStepFinding,
      'opening-form': m.launch.dsStepForm,
      exporting: m.launch.dsStepExporting,
      probing: m.launch.acStepProbing.replace('{f}', detail ?? ''),
      parsing: m.launch.dsStepParsing
    })[step] ?? ''

  const load = useCallback((): void => {
    window.zto.console.dataSafetyDoc(file).then(setDoc)
  }, [file])
  useEffect(load, [load])

  // 자동화 한 판을 돌린다. 브라우저는 **처음부터 띄운다**(Dan 2026-07-30 재확인).
  // 숨겨봤더니 콘솔 SPA가 부팅을 못 했다(a=0, text=49) — 창에 안 붙은 뷰는 컴포지터가 없어
  // 렌더가 안 돈다. `setBackgroundThrottling(false)`는 '가려진 뷰'까지만 커버한다.
  // 덤으로 사용자가 무슨 일이 일어나는지 보게 되는 건 부작용이 아니라 이점이다.
  const runAutomation = async <T extends { ok: boolean; step: string; error?: string }>(
    task: () => Promise<T>
  ): Promise<T> => {
    setBusy(true)
    setFailed(false)
    setFormUrl('')
    setMsg(m.launch.dsStepOpening)
    // URL 없이 연다 — 자동화가 자기 탭을 만들어 콘솔로 이동하므로, 여기서 주소를 주면
    // 사용자 탭까지 같은 페이지를 한 번 더 로드한다(탭 두 개가 같은 곳을 보게 된다)
    open()
    await new Promise((r) => setTimeout(r, 700)) // 슬라이드-오버가 열리고 뷰가 붙을 때까지
    const running = m.launch.dsVeil.replace('{t}', m.launch.dsTaskName)
    setGuide({ text: running, tone: 'run' })
    const off = window.zto.console.onProgress((p) => {
      setMsg(stepText(p.step, p.detail) || '')
      // 사람이 직접 해야 하는 단계면 안내 바를 '요청' 톤으로 — 문구는 브라우저 밖에 뜬다
      if (p.step === 'needs-user') setGuide({ text: p.detail ?? '', tone: 'ask' })
      else setGuide({ text: running, tone: 'run' })
    })
    const r = await task()
    off()
    setGuide(null)
    setBusy(false)
    // 끝나면 닫는다 — 실패 메시지는 오버레이 뒤 대시보드에 뜨므로 실패일수록 닫아야 보인다(문서 §10)
    close()
    return r
  }

  const run = async (): Promise<void> => {
    const r = await runAutomation(() =>
      window.zto.console.pullDataSafety(
        file,
        m.launch.dsAskLogin,
        m.launch.dsAskChooseDev,
        m.launch.dsAskExport
      )
    )
    if (r.ok && r.doc) {
      load() // 가져온 내용을 화면에 반영
      setMsg(
        m.launch.dsStepDone
          .replace('{n}', String(r.doc.questions.length))
          .replace('{a}', String(r.doc.answeredCount))
      )
    } else if (r.step === 'login-required') {
      setMsg(m.launch.dsStepLogin)
      if (r.formUrl) open(r.formUrl) // 로그인 화면을 바로 띄워준다
    } else {
      setFailed(true)
      setMsg(m.launch.dsStepFailed.replace('{e}', r.error ?? ''))
      if (r.formUrl) setFormUrl(r.formUrl)
    }
  }

  // 앱 콘텐츠 선언 정찰 — 콘텐츠 등급·타깃 연령은 CSV가 없어 DOM 경로다.
  // 매핑을 설계하려면 라이브 폼이 실제로 어떻게 생겼는지부터 회수해야 한다.
  const probe = async (): Promise<void> => {
    const r = await runAutomation(() =>
      window.zto.console.probeAppContent(file, m.launch.dsAskLogin, m.launch.dsAskChooseDev)
    )
    if (r.ok && r.doc) {
      const ctrls = r.doc.forms.reduce((n, f) => n + f.controls.length, 0)
      setMsg(
        m.launch.acProbeDone
          .replace('{n}', String(r.doc.forms.length))
          .replace('{c}', String(ctrls))
      )
    } else {
      setFailed(true)
      setMsg(m.launch.dsStepFailed.replace('{e}', r.error ?? ''))
    }
  }

  return (
    <div className="dash-sub">
      <div className="survey-btns">
        <button
          className="ghost-btn mini"
          disabled={busy}
          onClick={run}
          title={m.launch.dsPullTitle}
        >
          {m.launch.dsPull}
        </button>
        <button
          className="ghost-btn mini"
          disabled={busy}
          onClick={probe}
          title={m.launch.acProbeTitle}
        >
          {m.launch.acProbe}
        </button>
        {msg && !failed && <span className="ds-pull-msg">{msg}</span>}
        {doc && (
          <>
            <span className="ds-imported">
              ✓ {m.launch.dsImported
                .replace('{n}', String(doc.questions.length))
                .replace('{a}', String(doc.answeredCount))}
              {doc.at && ` · ${new Date(doc.at).toLocaleDateString()}`}
            </span>
            <button className="ghost-btn mini" onClick={() => setShowAnswers((v) => !v)}>
              {showAnswers ? m.launch.hideHistory : m.launch.dsViewAnswers}
            </button>
          </>
        )}
      </div>
      {doc && showAnswers && (
        <div className="ds-answers">
          {/* 217 vs 25를 진행률처럼 보이게 뒀더니 "12%만 됐다"로 읽혔다(Dan 2026-07-30).
              분모는 '해야 할 일'이 아니라 '물어볼 수 있는 전체'다 — 그 사실을 여기서 밝힌다. */}
          <div className="ds-answers-note">
            {m.launch.dsScope.replace('{n}', String(doc.questions.length))}
          </div>
          {doc.questions
            .filter((q) => q.answered)
            .map((q) => (
              <div key={q.id} className="ds-answer-row">
                <span className="ds-answer-q">{q.label}</span>
                <span className="ds-answer-a">
                  {q.value || q.options.filter((o) => o.selected).map((o) => o.label).join(', ')}
                </span>
              </div>
            ))}
        </div>
      )}
      {/* 실패는 작은 회색 글씨로 묻히면 안 된다 — 오버레이가 닫힌 자리에서 바로 읽히게 */}
      {failed && msg && (
        <div className="ds-pull-fail">
          <span className="ds-fail-text">{msg}</span>
          <span className="ds-fail-acts">
            {formUrl && (
              <button className="ghost-btn mini" onClick={() => open(formUrl)}>
                {m.launch.dsOpenForm}
              </button>
            )}
            <button className="ghost-btn mini" disabled={busy} onClick={run}>
              {m.launch.dsRetry}
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

function AndroidTree({
  g,
  file,
  metaDirty,
  surveys,
  assetEdits,
  onStage,
  onImage,
  onOpenMeta,
  onOpenSurvey
}: {
  g: DashGoogle
  file: string
  metaDirty: boolean
  surveys: SurveyItem[]
  assetEdits: Record<string, PendingEdit>
  onStage: (e: PendingEdit) => void
  onImage: (urls: string[], idx: number) => void
  onOpenMeta: () => void
  onOpenSurvey: (id: string) => void
}): React.JSX.Element {
  const { m } = useI18n()
  const releases = [...g.releases].sort((a, b) => playRank(a.track) - playRank(b.track))
  const configReadable = [g.details.defaultLanguage, g.details.contactEmail]
    .filter(Boolean)
    .join(' · ')
  // 릴리스가 하나라도 있으면 선언은 통과한 것 (Play가 선언 없이는 출시를 막는다)
  const declaredDone = releases.length > 0
  const assetDirty = Object.values(assetEdits).some(
    (e) => e.platform === 'android' && e.section === 'assets'
  )
  // 자산을 읽어온 로케일. `imageLocale`은 나중에 생긴 필드라 **그 전에 저장된 캐시엔 없다** —
  // 없다고 편집 행을 통째로 숨기면 "새로고침 전까지 기능이 사라진" 것처럼 보인다(2026-07-30 실제로 그랬다).
  // 그래서 main과 같은 규칙(ko 우선, 없으면 첫 리스팅)으로 되짚는다. 새로고침하면 실제 값이 온다.
  const imageLocale =
    g.imageLocale ||
    (g.listings.find((l) => l.locale.toLowerCase().startsWith('ko')) ?? g.listings[0])?.locale ||
    ''
  // API 연결 노드는 앱별이 아니라 전역(타이틀 우측)으로 승격됨 — 트리에서는 생략
  return (
    <>
      {/* 출시된 앱은 앱 콘텐츠 선언이 이미 통과한 상태다 — Play가 선언 없이는 어떤 트랙도
          내보내주지 않는다. 그래서 '가져온 앱' 플래그를 새로 만들지 않고 릴리스 유무에서
          끌어낸다. 앰버로 박아두면(예전 동작) 다 끝난 앱에도 영원히 경고색이 뜬다.
          수정 동기화는 하지 않기로 했으므로(2026-07-30) 여기서 할 일은 **불을 켜고
          어디서 보는지 알려주는 것까지**다. */}
      <Node
        light={declaredDone ? 'g' : 'o'}
        label={m.launch.dashNodeConfig}
        url={PLAY_CONSOLE_URL}
      >
        {[configReadable, declaredDone ? m.launch.dashDeclDone : m.launch.dashConfigConsole]
          .filter(Boolean)
          .join(' · ')}
      </Node>
      <WhereToCheck where={m.launch.dashWherePlay} items={m.launch.dashWherePlayItems} />
      <SurveyButtons surveys={surveys} onOpen={onOpenSurvey} />
      <DataSafetyPull file={file} />
      <Node light={metaDirty ? 'y' : g.listings.length > 0 ? 'g' : 'o'} label={m.launch.dashNodeMeta}>
        <LocaleChips locales={g.listings.map((l) => l.locale)} />
      </Node>
      {g.listings.length > 0 && (
        <MetaSub
          rows={g.listings}
          file={file}
          render={(e) => (e.google ? summarizeMeta(e.google.listings) : null)}
          onOpenFull={onOpenMeta}
        />
      )}
      {/* 대기 중인 자산 교체가 있으면 🟡 — 메타 편집과 같은 신호 체계(적용 전에는 노랑) */}
      <Node
        light={assetDirty ? 'y' : g.images.length > 0 ? 'g' : 'o'}
        label={m.launch.dashNodeAssets}
      >
        {g.images.map((s) => playAssetLabel(m, s)).join(' · ')}
      </Node>
      {g.images.length > 0 && (
        <div className="dash-sub">
          {imageLocale ? (
            <AssetEditor
              locale={imageLocale}
              sets={g.images}
              edits={assetEdits}
              label={(s) => playAssetLabel(m, s)}
              onStage={onStage}
              onOpen={onImage}
            />
          ) : (
            <AssetStrip sets={g.images} label={(s) => playAssetLabel(m, s)} onOpen={onImage} />
          )}
          {/* 교체는 대표 로케일 하나에만 적용된다 — 숨기면 다른 언어도 바뀐 줄 안다 */}
          {imageLocale && (
            <div className="asset-note">
              {m.launch.assetLocaleNote.replace('{l}', imageLocale)} {m.launch.assetWholeSet}
            </div>
          )}
          <div>
            <HistoryToggle
              file={file}
              render={(e) =>
                e.google ? e.google.images.map((s) => playAssetLabel(m, s)).join(' · ') || '—' : null
              }
            />
          </div>
        </div>
      )}
      <Node light={g.iap.length > 0 ? 'g' : 'o'} label={m.launch.dashNodeIap}>
        {g.iap.length > 0
          ? m.launch.dashIapLive.replace('{n}', String(g.iap.length))
          : m.launch.liveNone}
      </Node>
      {g.iap.length > 0 && (
        <>
          <IapSub items={g.iap} />
          <div className="dash-sub">
            <div>
              <HistoryToggle
                file={file}
                render={(e) => (e.google ? summarizeIap(e.google.iap) : null)}
              />
            </div>
          </div>
        </>
      )}
      <SheetIapApply file={file} />
      <Node
        light={g.closedStarted ? 'y' : 'o'}
        label={m.launch.dashNodeClosed}
        url={PLAY_CONSOLE_URL}
      >
        {g.closedStarted ? m.launch.dashClosedStarted : m.launch.dashClosedNotStarted}
        {' · '}
        {m.launch.dashClosedPass}
      </Node>
      <Node light={releases.length > 0 ? 'g' : 'o'} label={m.launch.dashNodeVersions}>
        {releases.length > 0 ? String(releases.length) : ''}
      </Node>
      {releases.length > 0 && (
        <div className="dash-vers">
          {releases.map((r, i) => (
            <div key={`${r.track}-${i}`} className="dash-ver">
              <span className="dash-vno">{r.name || r.versionCodes.join(', ')}</span>
              <span className="dash-note" title={repNoteText(r.notes)}>
                {repNoteText(r.notes)}
              </span>
              <Chip
                label={
                  playTrackLabel(r.track) +
                  (r.status && r.status !== 'completed' ? ` · ${r.status}` : '')
                }
                tone={playStatusTone(r.status)}
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function IosTree({
  a,
  file,
  metaDirty,
  surveys,
  onImage,
  onOpenMeta,
  onOpenSurvey
}: {
  a: DashApple
  file: string
  metaDirty: boolean
  surveys: SurveyItem[]
  onImage: (urls: string[], idx: number) => void
  onOpenMeta: () => void
  onOpenSurvey: (id: string) => void
}): React.JSX.Element {
  const { m } = useI18n()
  // 카테고리·등급 둘 다 있어야 완료(🟢) — 일부만 있으면 미설정(⚪) + 콘솔 링크
  const configDone = !!(a.category && a.ageRating)
  const configVal = [a.category.toLowerCase(), a.ageRating.toLowerCase().replace(/_/g, ' ')]
    .filter(Boolean)
    .join(' · ')
  const shotLabels = a.screenshots.map((s) => ascShotLabel(m, s))
  // API 연결 노드는 전역(타이틀 우측)으로 승격됨 — 트리에서는 생략
  return (
    <>
      <Node
        light={configDone ? 'g' : 'o'}
        label={m.launch.dashNodeConfig}
        url={configDone ? undefined : ascAppUrl(a.appId)}
      >
        {configVal}
      </Node>
      <WhereToCheck where={m.launch.dashWhereAsc} items={m.launch.dashWhereAscItems} />
      <SurveyButtons surveys={surveys} onOpen={onOpenSurvey} />
      <Node light={metaDirty ? 'y' : a.meta.length > 0 ? 'g' : 'o'} label={m.launch.dashNodeMeta}>
        <LocaleChips locales={a.meta.map((l) => l.locale)} />
      </Node>
      {a.meta.length > 0 && (
        <MetaSub
          rows={a.meta}
          file={file}
          render={(e) => (e.apple ? summarizeMeta(e.apple.meta) : null)}
          onOpenFull={onOpenMeta}
        />
      )}
      <Node light={a.screenshots.length > 0 ? 'g' : 'o'} label={m.launch.dashNodeAssets}>
        {[...shotLabels, m.launch.dashIosIconBuild].join(' · ')}
      </Node>
      {a.screenshots.length > 0 && (
        <div className="dash-sub">
          <AssetStrip sets={a.screenshots} label={(s) => ascShotLabel(m, s)} onOpen={onImage} />
          <div>
            <HistoryToggle
              file={file}
              render={(e) =>
                e.apple
                  ? e.apple.screenshots.map((s) => ascShotLabel(m, s)).join(' · ') || '—'
                  : null
              }
            />
          </div>
        </div>
      )}
      <Node light={a.iap.length > 0 ? 'g' : 'o'} label={m.launch.dashNodeIap}>
        {a.iap.length > 0
          ? m.launch.dashIapLive.replace('{n}', String(a.iap.length))
          : m.launch.liveNone}
      </Node>
      {a.iap.length > 0 && (
        <>
          <IapSub items={a.iap} />
          <div className="dash-sub">
            <div>
              <HistoryToggle
                file={file}
                render={(e) => (e.apple ? summarizeIap(e.apple.iap) : null)}
              />
            </div>
          </div>
        </>
      )}
      <Node light={a.versions.length > 0 ? 'g' : 'o'} label={m.launch.dashNodeVersions}>
        {a.versions.length > 0 ? String(a.versions.length) : ''}
      </Node>
      {a.versions.length > 0 && (
        <div className="dash-vers">
          {a.versions.map((v) => {
            const chip = ascStateChip(v.state)
            return (
              <div key={v.version + v.createdAt} className="dash-ver">
                <span className="dash-vno">{v.version}</span>
                <span className="dash-note" title={v.note}>
                  {v.note}
                </span>
                <Chip label={chip.label} tone={chip.tone} />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

export default function AppDashboard({
  file,
  summary,
  onPulled
}: {
  file: string
  summary?: SheetSummary
  onPulled?: () => void
}): React.JSX.Element {
  const { m, locale } = useI18n()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<Platform | null>(null) // null = 데이터 보고 자동 선택
  const [lightbox, setLightbox] = useState<{ urls: string[]; idx: number } | null>(null)
  const [metaOpen, setMetaOpen] = useState(false)
  const [surveyOpen, setSurveyOpen] = useState<string | null>(null) // 열린 설문 id
  const [surveyPrefill, setSurveyPrefill] = useState<Record<string, string> | null>(null)
  const [surveyDone, setSurveyDone] = useState<Record<string, boolean>>({})
  const [surveys, setSurveys] = useState<QuestionnaireMeta[]>([]) // 플랫폼별 설문 목록(버전관리 JSON)
  const [edits, setEdits] = useState<Record<string, PendingEdit>>({})

  // 설문 목록은 앱과 무관 — 한 번만 로드
  useEffect(() => {
    window.zto.launch.questionnaireList().then(setSurveys)
  }, [])

  const refreshSurvey = useCallback(() => {
    surveys.forEach((s) => {
      window.zto.launch.getConsoleAnswers(file, s.id).then((a) => {
        setSurveyDone((prev) => ({ ...prev, [s.id]: !!a?.completedAt }))
      })
    })
  }, [file, surveys])
  useEffect(refreshSurvey, [refreshSurvey])

  // iOS 연령 등급만 스토어에서 읽힘(ageRatingDeclaration) → 프리필 확보 후 연다. 나머지는 바로.
  const openSurvey = useCallback(
    (id: string): void => {
      setSurveyPrefill(null)
      if (id === 'asc-age-rating') {
        window.zto.launch.ageRatingDeclaration(file).then((p) => {
          setSurveyPrefill(p)
          setSurveyOpen(id)
        })
      } else {
        setSurveyOpen(id)
      }
    },
    [file]
  )

  // 트리에 넘길 플랫폼별 설문 목록(라벨·완료여부)
  const surveysFor = (plat: Platform): { id: string; title: string; done: boolean }[] =>
    surveys
      .filter((q) => q.platform === plat)
      .map((q) => ({
        id: q.id,
        title: locale === 'ko' ? q.title : q.titleEn,
        done: !!surveyDone[q.id]
      }))

  // 대기 diff에 쌓거나(값이 다르면), 스토어 값과 같아지면 제거
  const stage = useCallback((e: PendingEdit) => {
    setEdits((prev) => {
      const next = { ...prev }
      if (e.newValue === e.oldValue) delete next[e.id]
      else next[e.id] = e
      return next
    })
  }, [])
  const metaDirty = (plat: EditPlatform): boolean =>
    Object.values(edits).some(
      (e) => e.platform === plat && (e.section === 'meta' || e.section === 'releaseNotes')
    )

  const pull = useCallback(() => {
    setLoading(true)
    window.zto.launch.dashboard(file).then((d) => {
      setData(d)
      setLoading(false)
      onPulled?.() // pull 후 아이콘 캐시가 채워졌을 수 있음 → 부모가 sheets 새로고침
    })
  }, [file, onPulled])

  useEffect(() => {
    setData(null)
    setTab(null)
    setLightbox(null)
    setEdits({}) // 다른 앱으로 넘어가면 대기 수정 초기화
    // 저장된 마지막 실황이 있으면 그걸 즉시 — 스토어 조회는 [새로고침]으로만. 없을 때만 자동 pull.
    let stale = false
    window.zto.launch.dashboardCached(file).then((c) => {
      if (stale) return
      if (c) setData((cur) => cur ?? c)
      else pull()
    })
    return () => {
      stale = true
    }
  }, [file, pull])

  const active: Platform = tab ?? (data && !data.google && data.apple ? 'ios' : 'android')
  const summaryChip = !data
    ? null
    : active === 'android'
      ? data.google && playSummary(data.google)
      : data.apple?.versions[0]
        ? ascStateChip(data.apple.versions[0].state)
        : null

  return (
    <div className="step">
      <div className="dash-app-head">
        {summary?.icon && <img className="dash-app-icon" src={summary.icon} alt="" />}
        <strong>{summary?.appName}</strong>
        <code>{summary?.packageName}</code>
        <span className="dash-head-right">
          <span className="dash-synced">
            {loading
              ? m.launch.liveLoading
              : data &&
                m.launch.dashSynced.replace(
                  '{t}',
                  new Date(data.pulledAt).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit'
                  })
                )}
          </span>
          <button className="ghost-btn" onClick={pull} disabled={loading}>
            ⟳ {m.launch.dashRefresh}
          </button>
        </span>
      </div>
      {!data ? (
        <p className="step-empty">{m.launch.liveLoading}</p>
      ) : (
        <>
          <div className="dash-tabs">
            <div className="seg">
              <button
                className={active === 'android' ? 'active' : ''}
                onClick={() => setTab('android')}
              >
                {m.launch.dashAndroid}
              </button>
              <button className={active === 'ios' ? 'active' : ''} onClick={() => setTab('ios')}>
                {m.launch.dashIos}
              </button>
            </div>
            {summaryChip && <Chip label={summaryChip.label} tone={summaryChip.tone} />}
          </div>
          <div className="dash-tree">
            {active === 'android' ? (
              data.google ? (
                <AndroidTree
                  g={data.google}
                  file={file}
                  metaDirty={metaDirty('android')}
                  surveys={surveysFor('android')}
                  assetEdits={edits}
                  onStage={stage}
                  onImage={(urls, idx) => setLightbox({ urls, idx })}
                  onOpenMeta={() => setMetaOpen(true)}
                  onOpenSurvey={openSurvey}
                />
              ) : (
                <PlatformError error={data.googleError} store="play" />
              )
            ) : data.apple ? (
              <IosTree
                a={data.apple}
                file={file}
                metaDirty={metaDirty('ios')}
                surveys={surveysFor('ios')}
                onImage={(urls, idx) => setLightbox({ urls, idx })}
                onOpenMeta={() => setMetaOpen(true)}
                onOpenSurvey={openSurvey}
              />
            ) : (
              <PlatformError error={data.appleError} store="asc" />
            )}
          </div>
        </>
      )}
      {lightbox && (
        <Lightbox
          urls={lightbox.urls}
          idx={lightbox.idx}
          onClose={() => setLightbox(null)}
          onNav={(next) => setLightbox({ ...lightbox, idx: next })}
        />
      )}
      {metaOpen && data && (
        <MetaModal data={data} edits={edits} stage={stage} onClose={() => setMetaOpen(false)} />
      )}
      {surveyOpen && (
        <ContentSurveyWizard
          file={file}
          questionnaireId={surveyOpen}
          consoleUrl={surveyConsoleUrl(surveyOpen, surveys, data)}
          // iOS 연령 등급만 스토어 프리필 가능 — 나머지는 read API 없어 자동 조회 불가 안내
          prefill={surveyOpen === 'asc-age-rating' ? surveyPrefill : null}
          noAutoFetch={surveyOpen !== 'asc-age-rating'}
          onClose={() => setSurveyOpen(null)}
          onSaved={refreshSurvey}
        />
      )}
      <ApplyBar
        file={file}
        edits={edits}
        onReset={() => setEdits({})}
        linkFor={(e) =>
          e.platform === 'ios'
            ? data?.apple
              ? `https://appstoreconnect.apple.com/apps/${data.apple.appId}/distribution/info`
              : 'https://appstoreconnect.apple.com'
            : PLAY_CONSOLE_URL
        }
        suggestedVersion={nextVersion((data?.apple?.versions ?? []).map((v) => v.version))}
        onApplied={(okIds) => {
          if (okIds.length === 0) return
          setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !okIds.includes(k))))
          pull() // 반영 성공분은 재-pull로 스토어에서 확인
        }}
      />
    </div>
  )
}
