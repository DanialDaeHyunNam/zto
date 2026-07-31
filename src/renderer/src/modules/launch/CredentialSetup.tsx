import { useEffect, useState } from 'react'
import type { StoreKind } from '../../../../shared/launch-types'
import { useI18n } from '../../i18n'
import { useBrowserOverlay } from '../../browser-overlay'

// ---------- 자격증명 등록 ----------
// 발급 안내까지만 있고 **받은 키를 넣을 곳이 없어서** 사용자가 답안 시트 JSON을 손으로
// 고쳐야 했다(ASC). 발급까지 데려다 놓고 등록에서 막히면 반쪽이다.
//
// 두 갈래를 한 화면에 둔다: ① 아직 키가 없다 → 콘솔로(가이드) ② 이미 받았다 → 여기 등록.
// 등록은 **검증에 통과해야 저장**된다 — 저장부터 하고 "연결됨"이라 쓰면 첫 조회에서 터진다.
const CONSOLE: Record<StoreKind, { url: string; exact: boolean }> = {
  play: { url: 'https://play.google.com/console', exact: false },
  apple: { url: 'https://appstoreconnect.apple.com/access/integrations/api', exact: true }
}

export default function CredentialSetup({
  store,
  onClose,
  onSaved
}: {
  store: StoreKind
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { m } = useI18n()
  const overlay = useBrowserOverlay()
  const [path, setPath] = useState('')
  const [keyId, setKeyId] = useState('')
  const [issuerId, setIssuerId] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const apple = store === 'apple'

  const goIssue = (): void => {
    const c = CONSOLE[store]
    onClose()
    overlay.open(c.url, {
      copilot: true,
      task: {
        goal: apple ? m.launch.apiGoalAsc : m.launch.apiGoalPlay,
        platform: apple ? 'ios' : 'android',
        why: apple ? m.launch.apiWhyAsc : m.launch.apiWhyPlay,
        exact: c.exact
      }
    })
    overlay.setGuide({ text: apple ? m.launch.apiGuideAsc : m.launch.apiGuidePlay, tone: 'ask' })
  }

  const pick = async (): Promise<void> => {
    const r = await window.zto.launch.pickCredential(store)
    if (r.path) {
      setPath(r.path)
      setErr('')
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    const r = await window.zto.launch.saveCredential(store, {
      path,
      keyId: apple ? keyId : undefined,
      issuerId: apple ? issuerId : undefined
    })
    setBusy(false)
    if (r.ok) {
      onSaved()
      onClose()
    } else {
      setErr(r.error ?? 'failed')
    }
  }

  const canSave = !!path && (!apple || (!!keyId.trim() && !!issuerId.trim()))

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="meta-modal cred-modal" onClick={(e) => e.stopPropagation()}>
        <div className="meta-modal-head">
          <strong>{apple ? m.launch.credTitleAsc : m.launch.credTitlePlay}</strong>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cap-body">
          <p className="cap-intro">{apple ? m.launch.credIntroAsc : m.launch.credIntroPlay}</p>

          {/* ① 아직 없다 */}
          <div className="cred-step">
            <span className="cred-step-label">{m.launch.credStepIssue}</span>
            <button className="choice small" onClick={goIssue}>
              {m.launch.credGoIssue}
            </button>
          </div>

          {/* ② 이미 받았다 */}
          <div className="cred-step col">
            <span className="cred-step-label">{m.launch.credStepRegister}</span>
            <div className="cred-file">
              <button className="choice small" onClick={pick}>
                {apple ? m.launch.credPickP8 : m.launch.credPickJson}
              </button>
              {/* 경로는 파일명만 — 전체 경로는 화면 소음이고, 어차피 우리가 검증해서 알려준다 */}
              {path && <code className="cred-path">{path.split('/').pop()}</code>}
            </div>
            {apple && (
              <div className="cred-ids">
                <input
                  className="email-input"
                  placeholder={m.launch.credKeyId}
                  value={keyId}
                  onChange={(e) => setKeyId(e.target.value)}
                />
                <input
                  className="email-input"
                  placeholder={m.launch.credIssuerId}
                  value={issuerId}
                  onChange={(e) => setIssuerId(e.target.value)}
                />
              </div>
            )}
            {err && <div className="asset-edit-err">{err}</div>}
            <div className="cred-foot">
              <span className="asset-note">{m.launch.credVerifyNote}</span>
              <button
                className="choice small active"
                disabled={!canSave || busy}
                onClick={save}
              >
                {busy ? m.launch.credVerifying : m.launch.credSave}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
