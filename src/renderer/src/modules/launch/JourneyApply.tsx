import { useCallback, useEffect, useState } from 'react'
import type { ApplyResult } from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'

// 신규 앱 여정 ③ — 스토어 반영. 앱 레코드 생성만 사람이(공개 API 없음 — 콘솔 점프+코파일럿),
// 생겼는지 감지와 초안 반영은 ZTO가 한다. 반영은 대시보드 편집과 같은 파이프(applyEdits)를
// 타므로 여기만 고장 나는 일이 없다. 스토어 write라 2단 컨펌(누르면 4초간 확인 상태).
type StoreState = 'checking' | 'missing' | 'ready' | 'confirm' | 'applying' | 'done'

function StoreRow({
  label,
  state,
  reason,
  results,
  onMake,
  onApply
}: {
  label: string
  state: StoreState
  reason?: string
  results: ApplyResult[]
  onMake: () => void
  onApply: () => void
}): React.JSX.Element {
  const { m } = useI18n()
  return (
    <div className="cred-row">
      <div className="cred-info">
        <strong>{label}</strong>
        <span className="placeholder">
          {state === 'checking'
            ? m.launch.jaChecking
            : state === 'missing'
              ? reason === 'no-creds' || reason === 'token-failed'
                ? m.launch.jaNoCreds
                : m.launch.jaMissing
              : state === 'applying'
                ? m.launch.jaApplying
                : state === 'done'
                  ? results.every((r) => r.ok)
                    ? m.launch.jaDone
                    : m.launch.jaPartial
                  : m.launch.jaReady}
        </span>
        {state === 'done' && (
          <ul className="apply-results">
            {results.map((r) => (
              <li key={r.id} className={r.ok ? 'ok' : 'err'}>
                {r.id.split(':').pop()} — {r.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="choice-row">
        {state === 'missing' && (
          <button className="choice small" onClick={onMake}>
            {m.launch.jaMakeInConsole}
          </button>
        )}
        {(state === 'ready' || state === 'confirm' || state === 'done') && (
          <button
            className={`choice small ${state === 'confirm' ? 'active' : ''}`}
            onClick={onApply}
          >
            {state === 'confirm' ? m.launch.jaApplyConfirm : m.launch.jaApply}
          </button>
        )}
      </div>
    </div>
  )
}

export default function JourneyApply({
  file,
  onMakeInConsole
}: {
  file: string
  // 콘솔 점프는 부모가 연다 — 코파일럿 task(앱·목적)를 만드는 재료가 부모에 있다
  onMakeInConsole: (platform: 'android' | 'ios') => void
}): React.JSX.Element {
  const { m } = useI18n()
  const [hasDraft, setHasDraft] = useState(true)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    window.zto.launch.getListing(file).then((l) => {
      if (!l) return setHasDraft(false)
      const vals = [...Object.values(l.android), ...Object.values(l.ios)]
      setHasDraft(vals.some((v) => v.trim() !== ''))
    })
  }, [file])
  const copyHandoff = (): void => {
    void window.zto.launch.handoffText(file).then((t) => {
      void navigator.clipboard.writeText(t)
      setCopied(true)
      setTimeout(() => setCopied(false), 3000)
    })
  }
  const [play, setPlay] = useState<StoreState>('checking')
  const [ios, setIos] = useState<StoreState>('checking')
  const [playReason, setPlayReason] = useState<string>()
  const [iosReason, setIosReason] = useState<string>()
  const [playResults, setPlayResults] = useState<ApplyResult[]>([])
  const [iosResults, setIosResults] = useState<ApplyResult[]>([])

  const check = useCallback((): void => {
    setPlay('checking')
    setIos('checking')
    window.zto.launch.journeyStores(file).then((s) => {
      setPlay(s.play.exists ? 'ready' : 'missing')
      setPlayReason(s.play.reason)
      setIos(s.ios.exists ? 'ready' : 'missing')
      setIosReason(s.ios.reason)
    })
  }, [file])
  useEffect(check, [check])

  const apply = (platform: 'android' | 'ios'): void => {
    const [st, setSt, setResults] =
      platform === 'android'
        ? ([play, setPlay, setPlayResults] as const)
        : ([ios, setIos, setIosResults] as const)
    if (st === 'applying') return
    // 2단 컨펌 — 스토어 write는 한 번 눌렀다고 나가지 않는다. 4초 안에 한 번 더
    if (st === 'ready' || st === 'done') {
      setSt('confirm')
      setTimeout(() => setSt((cur: StoreState) => (cur === 'confirm' ? 'ready' : cur)), 4000)
      return
    }
    setSt('applying')
    window.zto.launch.applyListing(file, platform).then((rs) => {
      setResults(rs)
      setSt('done')
    })
  }

  if (!hasDraft) return <p className="step-note no-indent">{m.launch.jaNoDraft}</p>

  return (
    <div className="rows">
      <StoreRow
        label={m.launch.jaPlay}
        state={play}
        reason={playReason}
        results={playResults}
        onMake={() => onMakeInConsole('android')}
        onApply={() => apply('android')}
      />
      <StoreRow
        label={m.launch.jaAsc}
        state={ios}
        reason={iosReason}
        results={iosResults}
        onMake={() => onMakeInConsole('ios')}
        onApply={() => apply('ios')}
      />
      <div className="choice-row" style={{ marginTop: 8 }}>
        {(play === 'missing' || ios === 'missing') && (
          <button className="ghost-btn mini" onClick={check}>
            {m.launch.jaRecheck}
          </button>
        )}
        {/* 여정 ④ — 빌드는 여기 소관이 아니다. 만들어진 것을 들고 LLM CLI로 간다 */}
        <button className="ghost-btn mini" onClick={copyHandoff}>
          {copied ? m.launch.jaHandoffDone : m.launch.jaHandoff}
        </button>
      </div>
    </div>
  )
}
