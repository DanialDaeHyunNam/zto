import BrowserSurface from './BrowserSurface'
import AiPanel from './AiPanel'

// 소셜미디어 관리 (ROADMAP #6 소셜 코파일럿) — 중앙 임베드 브라우저(유저 직접 로그인) + 우측 AI 패널.
// 브라우저는 공용 기반(BrowserSurface). 같은 기반을 앱스토어 콘솔 싱크가 나중에 재사용.
export default function SocialPage(): React.JSX.Element {
  return (
    <div className="social-page">
      <BrowserSurface />
      {/* 소셜은 옵트인 — 기본은 안 읽는다(피드엔 남의 글·DM이 섞여 있다) */}
      <AiPanel watchable />
    </div>
  )
}
