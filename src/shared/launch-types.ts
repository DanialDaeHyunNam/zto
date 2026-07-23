// main ↔ preload ↔ renderer가 공유하는 모듈 1 타입
export interface SheetSummary {
  file: string
  appName: string
  packageName: string
  iapCount: number
  icon?: string // data URI (로컬 캐시된 스토어 아이콘)
}

export interface SheetIapInfo {
  packageName: string
  products: { productId: string; title: string; priceLabel: string }[]
}

export interface RunResult {
  ok: boolean
  output: unknown
  stderr?: string
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

// ---------- §4.5 앱 대시보드 (P1 읽기 전용) — 스토어 실황 pull 결과 ----------

export interface LiveIapProduct {
  id: string
  title: string
  state: string
  priceLabel?: string
}

// Play 트랙별 현재 릴리스 — 트랙 안에 살아있는 릴리스만 온다 (과거 버전 이력 API는 없음)
export interface PlayReleaseRow {
  track: string
  status: string
  name: string
  versionCodes: string[]
  notes: { locale: string; text: string }[] // 로케일별 릴리스 노트
}

// 스토어에 올라가 있는 이미지 자산 묶음 (타입별 URL 목록 — 스토어 CDN 직링크)
export interface DashImageSet {
  type: string // Play: icon·featureGraphic·phoneScreenshots / ASC: screenshotDisplayType
  urls: string[]
}

// 로케일별 스토어 메타 — Play: title/short/full, ASC: name/subtitle + 버전 로컬라이제이션의 desc/promo/keywords
export interface MetaListing {
  locale: string
  title: string
  short: string
  full: string
  promo: string // iOS 전용 (promotionalText)
  keywords: string // iOS 전용
}

export interface DashGoogle {
  releases: PlayReleaseRow[]
  listings: MetaListing[]
  details: { defaultLanguage: string; contactEmail: string; contactWebsite: string }
  images: DashImageSet[]
  iap: LiveIapProduct[]
  closedStarted: boolean // closed 계열 트랙(alpha·커스텀)에 릴리스 존재 여부로 유추
}

export interface AscVersionRow {
  version: string
  state: string
  createdAt: string
  note: string
}

export interface DashApple {
  appId: string // 콘솔 딥링크용
  versions: AscVersionRow[]
  meta: MetaListing[] // appInfoLocalizations(name·subtitle) + 최신 버전 로컬라이제이션(desc·promo·keywords) 병합
  releaseNotes: { locale: string; text: string }[] // 최신 버전 whatsNew (로케일별)
  category: string
  ageRating: string
  screenshots: DashImageSet[]
  iap: LiveIapProduct[]
}

// 스토어 스냅샷 — 스토어에 이력 API가 없어서 ZTO가 pull마다 저장해 이력을 만든다 (SPEC §4.5 ⑧)
// 메타·자산·IAP 전 섹션을 덮는다. 내용이 같으면 confirmedAt만 갱신, 다르면 새 항목.
export interface StoreSnapshotEntry {
  createdAt: string
  confirmedAt: string
  google: { listings: MetaListing[]; images: DashImageSet[]; iap: LiveIapProduct[] } | null
  apple: { meta: MetaListing[]; screenshots: DashImageSet[]; iap: LiveIapProduct[] } | null
}

export interface IapSnapshotInfo {
  count: number
  createdAt: string // 마지막 스냅샷이 처음 기록된 시각
  confirmedAt: string // 같은 내용이 마지막으로 확인된 시각
  changed: boolean // 이번 pull에서 직전 스냅샷과 달라졌는지
}

export interface DashboardData {
  pulledAt: string
  google: DashGoogle | null
  googleError?: string
  apple: DashApple | null
  appleError?: string
  snapshot: IapSnapshotInfo | null
}

// AI provider — BYO 2방식: 구독(로컬 CLI spawn: claude/codex) 또는 API 키(키체인 저장). ROADMAP #1.
export interface AiModel {
  id: string
  label: string
}

export type AiProviderId = 'claude' | 'chatgpt' | 'gemini'
export type AiMode = 'subscription' | 'apikey'

export interface AiProviderStatus {
  id: AiProviderId
  supportsSubscription: boolean // gemini는 CLI 구독 개념 없음 → API 키 전용
  subscriptionAvailable: boolean // 로컬 CLI 감지됨 (claude/codex)
  subscriptionVersion: string
  hasKey: boolean // API 키가 키체인에 저장됨
  mode: AiMode // 사용자가 고른 연결 방식
}

export interface AiStatus {
  active: AiProviderId // 두뇌로 쓸 provider
  model: string // active provider의 기본 모델 id
  models: AiModel[] // active provider가 제공하는 모델 (지금은 claude만)
  providers: AiProviderStatus[]
}

// ---------- 앱 콘텐츠 설문 (ROADMAP #2) — 콘솔 전용 설정을 결정형 위저드로 ----------
// 질문 세트는 버전 관리 JSON(launch/questionnaires/). 콘솔이 개정되면 그 파일만 갱신.
export type QuestionType = 'level' | 'bool'

export interface QuestionDef {
  id: string
  type: QuestionType
  label: string
  labelEn?: string
  help?: string
}

export interface Questionnaire {
  id: string
  platform: EditPlatform
  version: string
  title: string
  titleEn?: string
  questions: QuestionDef[]
}

// 답: level → NONE|INFREQUENT_OR_MILD|FREQUENT_OR_INTENSE, bool → YES|NO
export interface ConsoleAnswers {
  version: string
  answers: Record<string, string>
  completedAt: string // '' = 미완료
}

// 전역 API 연결 상태 — 자격증명은 앱이 아니라 브랜드/계정 단위(플랫폼당 하나)
export interface ApiStatus {
  play: { connected: boolean; detail: string }
  apple: { connected: boolean; detail: string }
}

// ---------- P2 편집 프레임 — 대기 중 수정(로컬 diff) → "수정 적용하기"로 배치 발사 ----------
export type EditPlatform = 'android' | 'ios'
export type EditSection = 'meta' | 'releaseNotes' | 'iap' | 'assets'

// 한 건의 대기 수정. id = `${platform}:${section}:${locale}:${field}` (같은 필드 재수정은 덮어씀)
export interface PendingEdit {
  id: string
  platform: EditPlatform
  section: EditSection
  field: string // meta: title·short·full·promo·keywords / releaseNotes: whatsNew ...
  locale: string
  label: string // 사람이 읽는 라벨 (적용 바·결과 패널용)
  oldValue: string
  newValue: string
}

// 적용 결과 — 항목별 (ASC는 부분 실패 가능, Play는 원자적)
export interface ApplyResult {
  id: string
  ok: boolean
  message: string
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

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// 편집거리 1 이내 판정 (오타 추정용)
function within1Edit(a: string, b: string): boolean {
  if (a === b) return false
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

// "gmail.cpm" 같은 도메인 오타 → 알려진 도메인으로 교정 제안
export function suggestEmailDomain(email: string): string | null {
  const [local, domain] = email.split('@')
  if (!local || !domain) return null
  const d = domain.toLowerCase()
  if (EMAIL_DOMAIN_APP[d]) return null
  for (const known of Object.keys(EMAIL_DOMAIN_APP)) {
    if (within1Edit(d, known)) return `${local}@${known}`
  }
  return null
}
