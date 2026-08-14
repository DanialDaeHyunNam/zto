import { useState } from 'react'
import BrowserSurface from './BrowserSurface'
import AiPanel from './AiPanel'

// 소셜미디어 관리 (ROADMAP #6 소셜 코파일럿) — 중앙 임베드 브라우저(유저 직접 로그인) + 우측 AI 패널.
// 브라우저는 공용 기반(BrowserSurface). 같은 기반을 앱스토어 콘솔 싱크가 나중에 재사용.
export default function SocialPage(): React.JSX.Element {
  // 왼쪽 툴바의 [화면 글]·[HTML] → 오른쪽 대화로. seq를 올려 "같은 종류를 또 눌렀을 때"도
  // 신호가 되게 한다(값만 보면 두 번째 클릭이 무시된다)
  const [inject, setInject] = useState<{ kind: 'text' | 'html'; seq: number } | null>(null)
  // AI가 화면을 필요로 하는데 읽기가 꺼져 있을 때 — 눌러야 할 버튼을 빛나게 한다
  const [need, setNeed] = useState<'text' | 'html' | null>(null)
  return (
    <div className="social-page">
      <BrowserSurface
        mode="social"
        highlight={need}
        onSendToAi={(kind) => {
          setNeed(null)
          setInject((p) => ({ kind, seq: (p?.seq ?? 0) + 1 }))
        }}
      />
      {/* 소셜은 옵트인 — 기본은 안 읽는다(피드엔 남의 글·DM이 섞여 있다) */}
      <AiPanel watchable inject={inject} onNeedPage={setNeed} />
    </div>
  )
}
