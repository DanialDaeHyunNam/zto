import { useEffect, useState } from 'react'
import { LISTING_LOCALES, type SheetListing } from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'

// 신규 앱 여정 ② — 콘텐츠 입력 (2026-08-14 Dan). 양대 스토어가 같은 정보를 다른 규격으로
// 받으므로 **2열에 각각 입력**한다(메타 상세 모달과 같은 배치라 눈이 이미 안다).
// iOS 아이콘 자리는 입력 대신 안내만 — App Store 아이콘은 빌드(Asset Catalog) 소속이라
// 여기서 넣을 수 없고, 완료 핸드오프에 파일로 실린다.
// 저장은 시트(초안)로만 — 스토어 반영은 앱 레코드가 생긴 뒤의 일이다.

const LIMIT = {
  aTitle: 30,
  aShort: 80,
  aFull: 4000,
  iName: 30,
  iSubtitle: 30,
  iKeywords: 100,
  iFull: 4000
}

function Field({
  label,
  value,
  max,
  area,
  onChange
}: {
  label: string
  value: string
  max: number
  area?: boolean
  onChange: (v: string) => void
}): React.JSX.Element {
  const { m } = useI18n()
  return (
    <label className="form-field">
      <span className="form-label">
        {label} <span className="placeholder">{m.launch.dashChars.replace('{n}', String(value.length))}</span>
      </span>
      {area ? (
        <textarea
          className="email-input"
          rows={6}
          value={value}
          maxLength={max}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="email-input"
          value={value}
          maxLength={max}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  )
}

export default function ListingForm({ file }: { file: string }): React.JSX.Element {
  const { m } = useI18n()
  const [l, setL] = useState<SheetListing | null>(null)
  const [saved, setSaved] = useState(false)
  const [iconErr, setIconErr] = useState('')

  useEffect(() => {
    window.zto.launch.getListing(file).then(setL)
    setSaved(false)
    setIconErr('')
  }, [file])

  if (!l) return <></>

  const upA = (patch: Partial<SheetListing['android']>): void => {
    setL({ ...l, android: { ...l.android, ...patch } })
    setSaved(false)
  }
  const upI = (patch: Partial<SheetListing['ios']>): void => {
    setL({ ...l, ios: { ...l.ios, ...patch } })
    setSaved(false)
  }

  const pickIcon = (): void => {
    void window.zto.launch.pickListingIcon(file).then((r) => {
      if (r.ok && r.name) {
        setIconErr('')
        upA({ icon: r.name })
        return
      }
      if (r.error === 'canceled') return
      const msg = r.error?.startsWith('size-')
        ? m.launch.listingIconSize.replace('{s}', r.error.slice(5))
        : r.error === 'too-big'
          ? m.launch.listingIconBig
          : m.launch.listingIconBad
      setIconErr(msg)
    })
  }

  const save = (): void => {
    void window.zto.launch.saveListing(file, l).then(setSaved)
  }

  return (
    <div>
      <p className="step-note no-indent">{m.launch.listingIntro}</p>
      <label className="form-field" style={{ maxWidth: 260 }}>
        <span className="form-label">{m.launch.listingLocale}</span>
        {/* 드롭다운인 이유: 같은 언어를 Play는 ko-KR, ASC는 ko로 받는다 — 자유 입력이면
            이 변환표를 못 태워 한쪽 반영이 조용히 깨진다 */}
        <select
          className="email-input"
          value={l.locale}
          onChange={(e) => {
            setL({ ...l, locale: e.target.value })
            setSaved(false)
          }}
        >
          {LISTING_LOCALES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label} — {o.value}
            </option>
          ))}
        </select>
      </label>
      <div className="meta-cols">
        <div className="meta-col">
          <div className="meta-col-head">{m.launch.dashAndroid}</div>
          <Field label={m.launch.dashFieldName} value={l.android.title} max={LIMIT.aTitle} onChange={(v) => upA({ title: v })} />
          <Field label={m.launch.dashFieldShort} value={l.android.short} max={LIMIT.aShort} onChange={(v) => upA({ short: v })} />
          <Field label={m.launch.dashFieldFull} value={l.android.full} max={LIMIT.aFull} area onChange={(v) => upA({ full: v })} />
          <div className="form-field">
            <span className="form-label">{m.launch.listingIcon}</span>
            <div className="choice-row">
              {l.android.icon && (
                <img
                  src={`zto-asset://${l.android.icon}`}
                  alt=""
                  style={{ width: 48, height: 48, borderRadius: 10 }}
                />
              )}
              <button className="choice small" onClick={pickIcon}>
                {m.launch.listingIconPick}
              </button>
            </div>
            {iconErr && <p className="field-err no-indent">{iconErr}</p>}
          </div>
        </div>
        <div className="meta-col">
          <div className="meta-col-head">{m.launch.dashIos}</div>
          <Field label={m.launch.dashFieldName} value={l.ios.name} max={LIMIT.iName} onChange={(v) => upI({ name: v })} />
          <Field label={m.launch.dashFieldSubtitle} value={l.ios.subtitle} max={LIMIT.iSubtitle} onChange={(v) => upI({ subtitle: v })} />
          <Field label={m.launch.dashFieldKeywords} value={l.ios.keywords} max={LIMIT.iKeywords} onChange={(v) => upI({ keywords: v })} />
          <Field label={m.launch.dashFieldFull} value={l.ios.full} max={LIMIT.iFull} area onChange={(v) => upI({ full: v })} />
          <div className="form-field">
            <span className="form-label">{m.launch.listingIcon}</span>
            <p className="step-note no-indent">{m.launch.listingIosIconNote}</p>
          </div>
        </div>
      </div>
      <div className="form-actions">
        {saved && <span className="status-chip ok">{m.launch.listingSaved}</span>}
        <button className="choice small active" onClick={save}>
          {m.launch.listingSave}
        </button>
      </div>
    </div>
  )
}
