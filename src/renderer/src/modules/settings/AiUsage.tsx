import { useEffect, useMemo, useState } from 'react'
import type { AiFeature, AiUsageEntry } from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'

// 설정의 AI 사용량 대시보드 — 모델별 사용량·비용.
// 형태 선택(dataviz): 합계는 차트가 아니라 통계 타일, 기간 추이는 스택 막대(구성+변화),
// 모델·사용처 비교는 가로 막대 행(범례 겸 표 역할 — 색만으로 식별하지 않게).
//
// 색: 검증된 카테고리 팔레트를 **모델 순서 고정**으로 배정한다(사용량 순 아님 —
// 필터로 계열이 줄어도 남은 계열의 색이 바뀌면 안 된다).
// dark 표면 #0e0e13 기준 6슬롯 전 항목 통과(최악 인접 CVD ΔE 8.4 / 정상시야 19.3 / 대비 ≥3:1).
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']
const OTHER_COLOR = '#6b6b78' // 목록에 없는(구버전) 모델 — 새 색을 만들지 않고 'Other'로 접는다
const MODEL_ORDER = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'gpt-5.4-mini',
  'gpt-5.4-nano'
]
const colorOf = (model: string): string => {
  const i = MODEL_ORDER.indexOf(model)
  return i >= 0 && i < SERIES.length ? SERIES[i] : OTHER_COLOR
}

const DAYS = 14
const fmtUsd = (n: number): string => (n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`)
const fmtInt = (n: number): string => n.toLocaleString()
const dayKey = (iso: string): string => iso.slice(0, 10)

interface Bucket {
  key: string
  calls: number
  inTok: number
  outTok: number
  billed: number
  estimate: number
}
const emptyBucket = (key: string): Bucket => ({
  key,
  calls: 0,
  inTok: 0,
  outTok: 0,
  billed: 0,
  estimate: 0
})
function addTo(b: Bucket, e: AiUsageEntry): void {
  b.calls += 1
  b.inTok += e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens
  b.outTok += e.outputTokens
  if (e.billed) b.billed += e.costUsd
  else b.estimate += e.costUsd
}

export default function AiUsage(): React.JSX.Element {
  const { m } = useI18n()
  const [entries, setEntries] = useState<AiUsageEntry[]>([])
  const [only, setOnly] = useState<string | null>(null) // 모델 필터 (null = 전체)

  const load = (): void => {
    window.zto.ai.usage().then(setEntries)
  }
  useEffect(load, [])

  const featureLabel = (f: AiFeature): string =>
    f === 'social'
      ? m.settings.usageFeatureSocial
      : f === 'survey'
        ? m.settings.usageFeatureSurvey
        : m.settings.usageFeatureOther

  // 최근 DAYS일 안의 기록만 본다 (날짜 축과 타일의 기준을 일치시킨다)
  const days = useMemo(() => {
    const out: string[] = []
    const now = new Date()
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(now.getDate() - i)
      out.push(d.toISOString().slice(0, 10))
    }
    return out
  }, [])

  const inRange = useMemo(
    () => entries.filter((e) => days.includes(dayKey(e.at))),
    [entries, days]
  )
  const shown = useMemo(
    () => (only ? inRange.filter((e) => e.model === only) : inRange),
    [inRange, only]
  )

  // 모델은 항상 고정 순서로 — 사용량 순으로 재정렬하면 색·순서가 흔들린다
  const models = useMemo(() => {
    const set = new Set(inRange.map((e) => e.model))
    const known = MODEL_ORDER.filter((mo) => set.has(mo))
    const unknown = [...set].filter((mo) => !MODEL_ORDER.includes(mo)).sort()
    return [...known, ...unknown]
  }, [inRange])

  const total = useMemo(() => {
    const b = emptyBucket('total')
    shown.forEach((e) => addTo(b, e))
    return b
  }, [shown])

  const byModel = useMemo(() => {
    const map = new Map<string, Bucket>()
    for (const e of shown) {
      const b = map.get(e.model) ?? emptyBucket(e.model)
      addTo(b, e)
      map.set(e.model, b)
    }
    return models.map((mo) => map.get(mo)).filter((b): b is Bucket => !!b)
  }, [shown, models])

  const byFeature = useMemo(() => {
    const map = new Map<string, Bucket>()
    for (const e of shown) {
      const b = map.get(e.feature) ?? emptyBucket(e.feature)
      addTo(b, e)
      map.set(e.feature, b)
    }
    return [...map.values()].sort((a, b) => b.calls - a.calls)
  }, [shown])

  // 스택 막대 — 하루 × 모델. 높이는 '비용'이 아니라 호출 수로 잡는다:
  // 구독 환산가와 API 실지출을 한 막대에 쌓으면 성격이 다른 값을 더하게 된다.
  const perDay = useMemo(() => {
    const map = new Map<string, Map<string, number>>()
    for (const e of shown) {
      const d = dayKey(e.at)
      const inner = map.get(d) ?? new Map<string, number>()
      inner.set(e.model, (inner.get(e.model) ?? 0) + 1)
      map.set(d, inner)
    }
    return days.map((d) => ({ day: d, models: map.get(d) ?? new Map<string, number>() }))
  }, [shown, days])

  const dayMax = Math.max(1, ...perDay.map((d) => [...d.models.values()].reduce((a, b) => a + b, 0)))
  const modelMax = Math.max(1, ...byModel.map((b) => b.calls))
  const featureMax = Math.max(1, ...byFeature.map((b) => b.calls))

  const clear = (): void => {
    if (!window.confirm(m.settings.usageClearConfirm)) return
    window.zto.ai.usageClear().then(load)
  }

  if (entries.length === 0) {
    return (
      <div className="settings-card">
        <h3 className="settings-h2">{m.settings.usageTitle}</h3>
        <div className="usage-empty">{m.settings.usageEmpty}</div>
      </div>
    )
  }

  return (
    <div className="settings-card">
      <div className="usage-head">
        <h3 className="settings-h2">{m.settings.usageTitle}</h3>
        <button className="ghost-btn" onClick={clear}>
          {m.settings.usageClear}
        </button>
      </div>
      <p className="settings-intro">{m.settings.usageIntro}</p>

      {/* 합계는 차트가 아니라 숫자다. 실지출과 환산가는 성격이 달라 절대 합치지 않는다. */}
      <div className="usage-tiles">
        <div className="usage-tile">
          <strong>{fmtUsd(total.billed)}</strong>
          <span>{m.settings.usageBilled}</span>
        </div>
        <div className="usage-tile muted-tile">
          <strong>{fmtUsd(total.estimate)}</strong>
          <span>{m.settings.usageEstimate}</span>
        </div>
        <div className="usage-tile">
          <strong>{fmtInt(total.calls)}</strong>
          <span>{m.settings.usageCalls}</span>
        </div>
        <div className="usage-tile">
          <strong>{fmtInt(total.inTok + total.outTok)}</strong>
          <span>{m.settings.usageTokens}</span>
        </div>
      </div>

      {/* 필터는 차트 위 한 줄에 */}
      <div className="usage-chips">
        <button className={`usage-chip ${only === null ? 'on' : ''}`} onClick={() => setOnly(null)}>
          {m.settings.usageAll}
        </button>
        {models.map((mo) => (
          <button
            key={mo}
            className={`usage-chip ${only === mo ? 'on' : ''}`}
            onClick={() => setOnly(only === mo ? null : mo)}
          >
            <span className="usage-swatch" style={{ background: colorOf(mo) }} />
            {mo}
          </button>
        ))}
      </div>

      <div className="usage-section-label">{m.settings.usageSpend14}</div>
      <div className="usage-bars">
        {perDay.map((d) => {
          const stackTotal = [...d.models.values()].reduce((a, b) => a + b, 0)
          return (
            <div key={d.day} className="usage-bar-col">
              <div className="usage-bar-stack">
                {models
                  .filter((mo) => d.models.get(mo))
                  .map((mo) => {
                    const v = d.models.get(mo) ?? 0
                    return (
                      <div
                        key={mo}
                        className="usage-bar-seg"
                        style={{
                          height: `${(v / dayMax) * 100}%`,
                          background: colorOf(mo)
                        }}
                        title={`${d.day} · ${mo} · ${v}${m.settings.usageCallsUnit}`}
                      />
                    )
                  })}
              </div>
              <span className="usage-bar-x">{d.day.slice(5).replace('-', '.')}</span>
              {stackTotal > 0 && <span className="usage-bar-n">{stackTotal}</span>}
            </div>
          )
        })}
      </div>

      {/* 모델별 행 = 범례 겸 표. 색 옆에 항상 이름·숫자가 붙어 색만으로 식별하지 않는다. */}
      <div className="usage-section-label">{m.settings.usageByModel}</div>
      <div className="usage-rows">
        {byModel.map((b) => (
          <div key={b.key} className="usage-row">
            <span className="usage-swatch" style={{ background: colorOf(b.key) }} />
            <span className="usage-row-name">{b.key}</span>
            <span className="usage-row-track">
              <span
                className="usage-row-fill"
                style={{ width: `${(b.calls / modelMax) * 100}%`, background: colorOf(b.key) }}
              />
            </span>
            <span className="usage-row-num">
              {fmtInt(b.calls)}
              {m.settings.usageCallsUnit}
            </span>
            <span className="usage-row-num">{fmtInt(b.inTok + b.outTok)}</span>
            <span className="usage-row-cost">
              {b.billed > 0 ? fmtUsd(b.billed) : <em>{fmtUsd(b.estimate)}</em>}
            </span>
          </div>
        ))}
      </div>

      <div className="usage-section-label">{m.settings.usageByFeature}</div>
      <div className="usage-rows">
        {byFeature.map((b) => (
          <div key={b.key} className="usage-row">
            <span className="usage-row-name">{featureLabel(b.key as AiFeature)}</span>
            <span className="usage-row-track">
              <span
                className="usage-row-fill neutral"
                style={{ width: `${(b.calls / featureMax) * 100}%` }}
              />
            </span>
            <span className="usage-row-num">
              {fmtInt(b.calls)}
              {m.settings.usageCallsUnit}
            </span>
            <span className="usage-row-cost">
              {b.billed > 0 ? fmtUsd(b.billed) : <em>{fmtUsd(b.estimate)}</em>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
