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
  RunResult,
  SheetIapInfo,
  SheetSummary,
  StoreSnapshotEntry
} from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'
import type { Messages } from '../../i18n/en'

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
function AssetStrip({
  sets,
  onOpen
}: {
  sets: DashImageSet[]
  onOpen: (urls: string[], idx: number) => void
}): React.JSX.Element {
  const all = sets.flatMap((s) => s.urls)
  let idx = 0
  return (
    <div className="dash-shots">
      {sets.flatMap((s) =>
        s.urls.map((u, i) => {
          const my = idx++
          return (
            <img
              key={`${s.type}-${i}`}
              src={u}
              alt={s.type}
              loading="lazy"
              onClick={() => onOpen(all, my)}
            />
          )
        })
      )}
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
  onReset
}: {
  file: string
  edits: Record<string, PendingEdit>
  onApplied: (okIds: string[]) => void
  onReset: () => void
}): React.JSX.Element | null {
  const { m } = useI18n()
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'running'>('idle')
  const [results, setResults] = useState<ApplyResult[] | null>(null)
  const pending = Object.values(edits)

  if (pending.length === 0 && !results) return null

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
                return (
                  <div key={r.id} className="result-row">
                    <span className={`dash-dot ${r.ok ? 'g' : 'y'}`} />
                    <span className="result-label">{e?.label ?? r.id}</span>
                    <span className="result-msg">{r.message}</span>
                  </div>
                )
              })}
            </div>
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

function AndroidTree({
  g,
  file,
  metaDirty,
  onImage,
  onOpenMeta
}: {
  g: DashGoogle
  file: string
  metaDirty: boolean
  onImage: (urls: string[], idx: number) => void
  onOpenMeta: () => void
}): React.JSX.Element {
  const { m } = useI18n()
  const releases = [...g.releases].sort((a, b) => playRank(a.track) - playRank(b.track))
  const configReadable = [g.details.defaultLanguage, g.details.contactEmail]
    .filter(Boolean)
    .join(' · ')
  // API 연결 노드는 앱별이 아니라 전역(타이틀 우측)으로 승격됨 — 트리에서는 생략
  return (
    <>
      <Node light="y" label={m.launch.dashNodeConfig} url={PLAY_CONSOLE_URL}>
        {[configReadable, m.launch.dashConfigConsole].filter(Boolean).join(' · ')}
      </Node>
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
      <Node light={g.images.length > 0 ? 'g' : 'o'} label={m.launch.dashNodeAssets}>
        {g.images.map((s) => playAssetLabel(m, s)).join(' · ')}
      </Node>
      {g.images.length > 0 && (
        <div className="dash-sub">
          <AssetStrip sets={g.images} onOpen={onImage} />
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
  onImage,
  onOpenMeta
}: {
  a: DashApple
  file: string
  metaDirty: boolean
  onImage: (urls: string[], idx: number) => void
  onOpenMeta: () => void
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
          <AssetStrip sets={a.screenshots} onOpen={onImage} />
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
  const { m } = useI18n()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<Platform | null>(null) // null = 데이터 보고 자동 선택
  const [lightbox, setLightbox] = useState<{ urls: string[]; idx: number } | null>(null)
  const [metaOpen, setMetaOpen] = useState(false)
  const [edits, setEdits] = useState<Record<string, PendingEdit>>({})

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
                  onImage={(urls, idx) => setLightbox({ urls, idx })}
                  onOpenMeta={() => setMetaOpen(true)}
                />
              ) : (
                <PlatformError error={data.googleError} store="play" />
              )
            ) : data.apple ? (
              <IosTree
                a={data.apple}
                file={file}
                metaDirty={metaDirty('ios')}
                onImage={(urls, idx) => setLightbox({ urls, idx })}
                onOpenMeta={() => setMetaOpen(true)}
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
      <ApplyBar
        file={file}
        edits={edits}
        onReset={() => setEdits({})}
        onApplied={(okIds) => {
          if (okIds.length === 0) return
          setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !okIds.includes(k))))
          pull() // 반영 성공분은 재-pull로 스토어에서 확인
        }}
      />
    </div>
  )
}
