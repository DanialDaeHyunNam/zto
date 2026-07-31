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
  error?: string
}
