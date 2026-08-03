// 렌더러가 보는 라이선스 상태. main의 license.ts와 모양을 맞춘다
// launch-types와 **파일을 나눈** 이유: 라이선스는 판매 로직이라 스토어 도메인 타입과 수명이 다르다
export type Plan = 'byo' | 'plus'
export type LicenseState = 'none' | 'active' | 'expired' | 'disabled' | 'wrong-product'

export interface LicenseInfo {
  state: LicenseState
  plan?: Plan
  keyMasked?: string
  lastCheckedAt?: string
  offlineUntil?: string
  trialStartedAt?: string
  trialEndsAt?: string
  trialActive: boolean
  entitled: boolean
  // 공식 배포 빌드인가(빌드 타임 MAIN_VITE_OFFICIAL). 게이트는 공식 빌드에만 있다 —
  // 소스 빌드는 LICENSE.md가 이미 무료를 허용하므로 잠글 이유가 없다(잠금은 방어가 아니라 퍼널)
  official: boolean
  error?: string
}
