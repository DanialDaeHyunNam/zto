// main ↔ preload ↔ renderer가 공유하는 모듈 1 타입
export interface SheetSummary {
  file: string
  appName: string
  packageName: string
  iapCount: number
}

export interface CredentialStatus {
  googleSa: { path: string; ok: boolean }
  asc: { keyPath: string; keyId: string; issuerId: string; ok: boolean }
}

// 스토어 개발자 계정 보유 상태 — 앱이 아닌 사용자/브랜드 소유라 답안 시트가 아닌 전역 상태
export type StoreKind = 'play' | 'apple'

export interface DevAccountState {
  status: 'yes' | 'no'
  email?: string
}

export interface DevAccounts {
  play?: DevAccountState
  apple?: DevAccountState
}

// 모듈 2 — 계정 인벤토리 항목 (메타데이터만. 비밀번호 필드는 설계상 존재하지 않는다 — SPEC §7.3)
export interface Account {
  id: string
  email: string
  memo: string
  apps: string[] // 연결된 앱 — PLATFORMS의 id
  createdAt: string
  updatedAt: string
}

// 비밀번호 접근 기록 (로컬 전용) — "내가 연 게 맞나"를 확인하는 유일한 수단
export interface AccessLogEntry {
  ts: string
  email: string
  appId: string
  action: 'reveal' | 'copy' | 'save' | 'update' | 'delete'
  ok: boolean
}

export interface LockState {
  unlocked: boolean
  remainingMs: number
}

// 연결 가능한 앱 카탈로그 — 개발자 콘솔 2종 + Postiz(github.com/gitroomhq/postiz-app) 지원 플랫폼 전체
export type PlatformCategory = 'console' | 'mail' | 'social'

export interface PlatformDef {
  id: string
  name: string
  category: PlatformCategory
}

export const PLATFORMS: PlatformDef[] = [
  { id: 'play-console', name: 'Play Console', category: 'console' },
  { id: 'app-store-connect', name: 'App Store Connect', category: 'console' },
  { id: 'gmail', name: 'Gmail', category: 'mail' },
  { id: 'naver', name: 'Naver Mail', category: 'mail' },
  { id: 'icloud', name: 'iCloud Mail', category: 'mail' },
  { id: 'outlook', name: 'Outlook', category: 'mail' },
  { id: 'yahoo', name: 'Yahoo Mail', category: 'mail' },
  { id: 'protonmail', name: 'Proton Mail', category: 'mail' },
  { id: 'daum', name: 'Daum Mail', category: 'mail' },
  { id: 'kakao', name: 'Kakao', category: 'mail' },
  { id: 'x', name: 'X', category: 'social' },
  { id: 'threads', name: 'Threads', category: 'social' },
  { id: 'instagram', name: 'Instagram', category: 'social' },
  { id: 'facebook', name: 'Facebook', category: 'social' },
  { id: 'youtube', name: 'YouTube', category: 'social' },
  { id: 'tiktok', name: 'TikTok', category: 'social' },
  { id: 'linkedin', name: 'LinkedIn', category: 'social' },
  { id: 'reddit', name: 'Reddit', category: 'social' },
  { id: 'bluesky', name: 'Bluesky', category: 'social' },
  { id: 'mastodon', name: 'Mastodon', category: 'social' },
  { id: 'pinterest', name: 'Pinterest', category: 'social' },
  { id: 'dribbble', name: 'Dribbble', category: 'social' },
  { id: 'discord', name: 'Discord', category: 'social' },
  { id: 'slack', name: 'Slack', category: 'social' },
  { id: 'telegram', name: 'Telegram', category: 'social' },
  { id: 'warpcast', name: 'Warpcast', category: 'social' },
  { id: 'lemmy', name: 'Lemmy', category: 'social' },
  { id: 'nostr', name: 'Nostr', category: 'social' },
  { id: 'vk', name: 'VK', category: 'social' },
  { id: 'kick', name: 'Kick', category: 'social' }
]

// 이메일 도메인 → 메일 서비스 앱. ID가 이메일이면 이 앱이 유저 설정 없이 강제 연결되고 항상 맨 앞.
const EMAIL_DOMAIN_APP: Record<string, string> = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'naver.com': 'naver',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'yahoo.com': 'yahoo',
  'yahoo.co.kr': 'yahoo',
  'proton.me': 'protonmail',
  'protonmail.com': 'protonmail',
  'pm.me': 'protonmail',
  'daum.net': 'daum',
  'hanmail.net': 'daum',
  'kakao.com': 'kakao'
}

// 앱 → 비밀번호 관리자 검색어(대표 도메인). 딥링크에 검색어 주입은 공식적으로 불가 → 클립보드 복사용
export const PLATFORM_DOMAINS: Record<string, string> = {
  'play-console': 'play.google.com',
  'app-store-connect': 'appstoreconnect.apple.com',
  gmail: 'google.com',
  naver: 'naver.com',
  icloud: 'apple.com',
  outlook: 'live.com',
  yahoo: 'yahoo.com',
  protonmail: 'proton.me',
  daum: 'daum.net',
  kakao: 'kakao.com',
  x: 'x.com',
  threads: 'threads.net',
  instagram: 'instagram.com',
  facebook: 'facebook.com',
  youtube: 'google.com',
  tiktok: 'tiktok.com',
  linkedin: 'linkedin.com',
  reddit: 'reddit.com',
  bluesky: 'bsky.app',
  mastodon: 'mastodon.social',
  pinterest: 'pinterest.com',
  dribbble: 'dribbble.com',
  discord: 'discord.com',
  slack: 'slack.com',
  telegram: 'telegram.org',
  warpcast: 'warpcast.com',
  lemmy: 'lemmy.world',
  nostr: 'nostr.com',
  vk: 'vk.com',
  kick: 'kick.com'
}

export function mailAppForEmail(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase()
  return domain ? (EMAIL_DOMAIN_APP[domain] ?? null) : null
}
