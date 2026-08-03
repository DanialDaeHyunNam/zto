// ---------- 라이선스 (Lemon Squeezy License API) ----------
// SPEC §8. 판매는 MoR(Lemon Squeezy), 라이선스 검증은 **앱이 직접** 한다.
//
// 서버가 없다. Lemon Squeezy의 License API는 스토어 API 키가 아니라 **라이선스 키 자체를
// 자격증명으로 쓰는 공개 API**라, 데스크톱 앱이 바로 부를 수 있다. 웹앱이라면 키가 브라우저에
// 노출되니 프록시를 두라고 권하지만, 데스크톱에서 그 키는 **사용자 자신의 키가 자기 기기에**
// 있는 것이라 숨길 대상이 아니다. 덕분에 "ZTO에는 서버가 없습니다"라는 약속을 Tier 1에서 지킨다.
//
// ⚠️ 그래서 **상품 확인이 필수다**: 검증은 "이 키가 Lemon Squeezy에서 유효한가"만 답한다.
// 우리 상품인지는 응답의 store/product id를 우리가 대조해야 한다 — 안 하면 아무 판매자의
// 아무 키나 통과한다.
import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'

const API = 'https://api.lemonsqueezy.com/v1/licenses'

// 스토어 개설 후 채운다. **비어 있으면 상품 대조를 건너뛴다**(개발 중 앱이 잠기지 않도록) —
// 배포 빌드에서 비어 있으면 안 된다.
// libertas (all-libertas.lemonsqueezy.com) — 2026-08-02 개설
// BYO는 단건 $5(평생) — 키에 expires_at이 없어(unlimited) 영구 active로 동작한다.
// 2026-08-03 테스트 키로 활성화→검증→해제 왕복 실증.
export const LS_STORE_ID = '443985'
export const LS_VARIANTS: Record<string, 'byo' | 'plus'> = {
  '1974924': 'byo', // ZTO 단건 $5 (상품 1263143 기본 variant)
  '1973940': 'plus', // ZTO Plus · Monthly $15
  '1973941': 'plus' // ZTO Plus · Yearly $150
}

export type Plan = 'byo' | 'plus'
export type LicenseState =
  | 'none' // 키 없음 — 체험 중이거나 만료
  | 'active'
  | 'expired'
  | 'disabled' // 환불·취소 등으로 죽은 키
  | 'wrong-product' // 유효하지만 우리 상품이 아님

export interface LicenseInfo {
  state: LicenseState
  plan?: Plan
  keyMasked?: string
  lastCheckedAt?: string
  // 오프라인 유예 만료. 네트워크 없이 쓸 수 있는 한계 시각
  offlineUntil?: string
  trialStartedAt?: string
  trialEndsAt?: string
  trialActive: boolean
  // 지금 이 앱을 쓸 수 있는가 = 라이선스 유효 or 체험 중
  entitled: boolean
  error?: string
}

interface Stored {
  key?: string // safeStorage 암호문 (base64)
  instanceId?: string
  plan?: Plan
  state?: LicenseState
  lastCheckedAt?: string
  trialStartedAt?: string
}

const TRIAL_DAYS = 3
// 네트워크가 없어도 이만큼은 쓴다. 비행기·오프라인에서 앱이 잠기면 안 된다 —
// 우리가 막고 싶은 건 무단 사용이지 인터넷 없는 사용자가 아니다.
const OFFLINE_GRACE_DAYS = 14
// 매 실행마다 부르지 않는다. 라이선스 상태가 하루 안에 바뀌어도 실질 피해가 없다.
const RECHECK_HOURS = 24

const days = (n: number): number => n * 24 * 60 * 60 * 1000

export function createLicense(file: string) {
  const read = (): Stored => {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Stored) : {}
    } catch {
      return {}
    }
  }
  const write = (s: Stored): void => {
    try {
      writeFileSync(file, JSON.stringify(s, null, 2))
    } catch {
      /* 저장 실패가 실행을 막지는 않는다 */
    }
  }
  const decodeKey = (s: Stored): string => {
    if (!s.key) return ''
    try {
      return safeStorage.decryptString(Buffer.from(s.key, 'base64'))
    } catch {
      return ''
    }
  }

  // 체험 시계는 **설치가 아니라 첫 스토어 연결 성공**부터 센다 (SPEC §8.6).
  // 이 앱은 시작에 준비물이 있다(서비스 계정·ASC 키 발급) — 설치부터 세면 사용자가
  // 자격증명 만드느라 체험을 다 쓰고 정작 대시보드는 못 본다.
  const startTrial = (): void => {
    const s = read()
    if (s.trialStartedAt) return
    write({ ...s, trialStartedAt: new Date().toISOString() })
  }

  const info = (): LicenseInfo => {
    const s = read()
    const now = Date.now()
    const trialEnds = s.trialStartedAt ? new Date(s.trialStartedAt).getTime() + days(TRIAL_DAYS) : 0
    const trialActive = trialEnds > now
    const checked = s.lastCheckedAt ? new Date(s.lastCheckedAt).getTime() : 0
    const offlineUntil = checked ? checked + days(OFFLINE_GRACE_DAYS) : 0
    // 유예 안이면 마지막으로 확인된 상태를 그대로 인정한다
    const licensed = s.state === 'active' && offlineUntil > now
    const key = decodeKey(s)
    return {
      state: s.state ?? 'none',
      plan: s.plan,
      keyMasked: key ? `${key.slice(0, 8)}…${key.slice(-4)}` : undefined,
      lastCheckedAt: s.lastCheckedAt,
      offlineUntil: offlineUntil ? new Date(offlineUntil).toISOString() : undefined,
      trialStartedAt: s.trialStartedAt,
      trialEndsAt: trialEnds ? new Date(trialEnds).toISOString() : undefined,
      trialActive,
      entitled: licensed || trialActive
    }
  }

  // 응답 해석은 한 곳에서 — activate와 validate가 같은 모양의 답을 준다
  const applyResponse = (
    j: {
      valid?: boolean
      activated?: boolean
      error?: string
      license_key?: { status?: string }
      meta?: { store_id?: number | string; variant_id?: number | string }
      instance?: { id?: string }
    },
    key: string,
    prev: Stored
  ): LicenseInfo => {
    const status = j.license_key?.status ?? ''
    const ok = (j.valid ?? j.activated ?? false) && status === 'active'
    let state: LicenseState = ok ? 'active' : status === 'expired' ? 'expired' : 'disabled'

    // **우리 상품인지 대조** — 이걸 빼면 아무 판매자의 키나 통과한다
    if (ok && LS_STORE_ID && String(j.meta?.store_id ?? '') !== LS_STORE_ID) state = 'wrong-product'
    const variant = String(j.meta?.variant_id ?? '')
    const plan = LS_VARIANTS[variant]
    if (ok && Object.keys(LS_VARIANTS).length > 0 && !plan) state = 'wrong-product'

    const next: Stored = {
      ...prev,
      key: safeStorage.encryptString(key).toString('base64'),
      instanceId: j.instance?.id ?? prev.instanceId,
      plan: plan ?? prev.plan,
      state,
      // **실패한 검증으로 유예 시계를 갱신하지 않는다** — 죽은 키가 14일 더 사는 걸 막는다
      lastCheckedAt: state === 'active' ? new Date().toISOString() : prev.lastCheckedAt
    }
    write(next)
    return { ...info(), error: state === 'active' ? undefined : (j.error ?? state) }
  }

  const post = async (path: string, body: Record<string, string>): Promise<Record<string, unknown>> => {
    const r = await fetch(`${API}/${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return (await r.json()) as Record<string, unknown>
  }

  // 이 기기를 등록한다. instance_name은 사람이 대시보드에서 알아볼 이름이면 된다
  const activate = async (key: string, deviceName: string): Promise<LicenseInfo> => {
    const trimmed = key.trim()
    if (!trimmed) return { ...info(), error: 'empty' }
    try {
      const j = await post('activate', { license_key: trimmed, instance_name: deviceName })
      return applyResponse(j, trimmed, read())
    } catch (e) {
      return { ...info(), error: String(e).slice(0, 160) }
    }
  }

  // 주기적 재확인. 네트워크가 없으면 **조용히 유예에 기댄다** — 여기서 상태를 깎으면
  // 인터넷이 잠깐 없는 사용자의 앱이 잠긴다
  const revalidate = async (force = false): Promise<LicenseInfo> => {
    const s = read()
    const key = decodeKey(s)
    if (!key) return info()
    const checked = s.lastCheckedAt ? new Date(s.lastCheckedAt).getTime() : 0
    if (!force && Date.now() - checked < RECHECK_HOURS * 60 * 60 * 1000) return info()
    try {
      const j = await post('validate', {
        license_key: key,
        ...(s.instanceId ? { instance_id: s.instanceId } : {})
      })
      return applyResponse(j, key, s)
    } catch {
      return info() // 오프라인 — 유예가 답한다
    }
  }

  const deactivate = async (): Promise<LicenseInfo> => {
    const s = read()
    const key = decodeKey(s)
    if (key && s.instanceId) {
      try {
        await post('deactivate', { license_key: key, instance_id: s.instanceId })
      } catch {
        /* 실패해도 로컬에서는 지운다 — 사용자가 이 기기에서 빼겠다는 뜻이다 */
      }
    }
    write({ trialStartedAt: s.trialStartedAt }) // 체험 기록은 남긴다(초기화 우회 방지)
    return info()
  }

  // Plus 프록시 호출용 — 프록시는 라이선스 키 자체를 자격증명으로 받는다(x-zto-license)
  const currentKey = (): string => decodeKey(read())

  return { info, activate, revalidate, deactivate, startTrial, currentKey }
}
