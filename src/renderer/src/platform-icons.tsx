import {
  siApple,
  siAppstore,
  siBluesky,
  siDiscord,
  siDribbble,
  siFacebook,
  siFarcaster,
  siGmail,
  siGooglechrome,
  siGoogleplay,
  siIcloud,
  siInstagram,
  siKakaotalk,
  siKick,
  siLemmy,
  siMastodon,
  siNaver,
  siPinterest,
  siProtonmail,
  siReddit,
  siTelegram,
  siThreads,
  siTiktok,
  siVk,
  siX,
  siYoutube,
  siLemonsqueezy,
  siStripe,
  siPaypal,
  siVercel,
  siSupabase,
  siFirebase,
  siCloudflare,
  siGooglecloud,
  siGithub,
  siAnthropic,
  siNotion,
  siFigma
} from 'simple-icons'
import { PLATFORMS } from '../../shared/launch-types'

const ICONS: Record<string, { path: string; hex: string }> = {
  // UI 전용 (PLATFORMS 카탈로그에 없음 → 선택기에 안 뜸)
  apple: siApple,
  chrome: siGooglechrome,
  'play-console': siGoogleplay,
  'app-store-connect': siAppstore,
  gmail: siGmail,
  naver: siNaver,
  icloud: siIcloud,
  protonmail: siProtonmail,
  kakao: siKakaotalk,
  x: siX,
  threads: siThreads,
  instagram: siInstagram,
  facebook: siFacebook,
  youtube: siYoutube,
  tiktok: siTiktok,
  reddit: siReddit,
  bluesky: siBluesky,
  mastodon: siMastodon,
  pinterest: siPinterest,
  dribbble: siDribbble,
  discord: siDiscord,
  telegram: siTelegram,
  warpcast: siFarcaster,
  lemmy: siLemmy,
  vk: siVk,
  kick: siKick,
  lemonsqueezy: siLemonsqueezy,
  stripe: siStripe,
  paypal: siPaypal,
  vercel: siVercel,
  supabase: siSupabase,
  firebase: siFirebase,
  cloudflare: siCloudflare,
  googlecloud: siGooglecloud,
  github: siGithub,
  anthropic: siAnthropic,
  notion: siNotion,
  figma: siFigma
}

// simple-icons에 없는 브랜드(정책상 제외)의 대체 브랜드색
const FALLBACK_COLORS: Record<string, string> = {
  linkedin: '#0A66C2',
  slack: '#611F69',
  nostr: '#662482',
  outlook: '#0F6CBD',
  yahoo: '#6001D2',
  daum: '#EC4E36',
  // simple-icons 미보유 SaaS
  openai: '#412991',
  aws: '#FF9900'
}

export const PLATFORM_NAMES: Record<string, string> = Object.fromEntries(
  PLATFORMS.map((p) => [p.id, p.name])
)

function luminance(hex: string): number {
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b
}

// 어두운 배경에서 검정 로고(X·Threads 등)가 안 보이므로 밝기 낮으면 currentColor로
function iconFill(hex: string): string {
  return luminance(hex) < 90 ? 'currentColor' : `#${hex}`
}

// 아이콘 타일 배경 틴트 — 브랜드색 16%, 어두운 브랜드는 흰색 8%
export function platformTint(id: string): string {
  const icon = ICONS[id]
  const hex = icon ? icon.hex : FALLBACK_COLORS[id]?.slice(1)
  if (!hex || luminance(hex) < 90) return 'rgba(255, 255, 255, 0.08)'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, 0.16)`
}

// 비밀번호 관리자로 이동함을 나타내는 열쇠 글리프
export function KeyGlyph({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="key-glyph" style={{ width: size, height: size }} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"
      />
    </svg>
  )
}

export function PlatformIcon({ id, size = 14 }: { id: string; size?: number }): React.JSX.Element {
  const icon = ICONS[id]
  if (icon) {
    return (
      <svg
        className="p-icon"
        style={{ width: size, height: size }}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d={icon.path} fill={iconFill(icon.hex)} />
      </svg>
    )
  }
  const name = PLATFORM_NAMES[id] ?? id
  return (
    <span
      className="p-icon letter"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.62,
        background: FALLBACK_COLORS[id] ?? '#666'
      }}
    >
      {name[0]}
    </span>
  )
}
