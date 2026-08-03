/// <reference types="electron-vite/node" />

// main 프로세스가 쓰는 빌드 타임 환경변수 (MAIN_VITE_ 프리픽스만 주입된다)
interface ImportMetaEnv {
  // '1'이면 공식 배포 빌드 — 만료 게이트가 켜진다. 소스 빌드에는 없다(= 게이트 없음)
  readonly MAIN_VITE_OFFICIAL?: string
}
