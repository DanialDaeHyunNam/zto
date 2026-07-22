import type { ZtoApi } from './index'

declare global {
  interface Window {
    zto: ZtoApi
  }
}

export {}
