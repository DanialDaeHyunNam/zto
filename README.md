# ZTO (Zero to One)

> 아무것도 없는 0에서, 앱이 세상에 나가 첫 팬을 만나는 1까지.

1인 개발사의 **앱 출시·계정·소셜**을 한 화면에서 다루는 데스크톱 앱 (macOS / Windows).

- **앱 스토어 관리** — 양대 스토어 실황을 한 화면에. 메타·자산·IAP·릴리스 노트를 여기서 고치고, API가 없는 것은 콘솔로 데려다주며 AI가 옆에서 거듭니다
- **계정 인벤토리** — 계정과 용도·연결 서비스를 한눈에. 비밀번호는 **OS 키체인에만**, 네트워크 전송 없음
- **소셜미디어 관리** — 임베드 브라우저에 직접 로그인하고, 원할 때만 AI가 화면을 읽습니다

자세한 설계는 [`SPEC.md`](SPEC.md), 작업 순서는 [`ROADMAP.md`](ROADMAP.md)에 있습니다.

---

## 설치

릴리스 페이지에서 내려받습니다. <!-- TODO: 배포 채널 확정 시 링크 -->

| 플랫폼 | 파일 |
|---|---|
| macOS — Apple Silicon (M1·M2·M3·M4) | `ZTO-<version>-arm64.dmg` |
| macOS — Intel | `ZTO-<version>.dmg` |
| Windows 10/11 | `ZTO Setup <version>.exe` |

**내 맥이 어느 쪽인지 모르겠다면**: 애플 메뉴  → 이 Mac에 관하여 → **칩** 줄에 Apple M… 또는 Intel이 적혀 있습니다.

### Windows에서 "Windows의 PC 보호" 경고가 뜹니다

**macOS 빌드는 애플 공증(notarization)을 거칩니다** — 경고 없이 바로 열립니다.

**Windows 설치 파일은 아직 코드 서명 인증서가 없습니다.** 그래서 첫 실행 때
*"Windows의 PC 보호"* 파란 화면이 뜹니다. 이건 **서명이 없다는 안내이지 악성코드 탐지가
아닙니다** — 서명 인증서는 매년 비용이 드는 물건이라 아직 사지 않았을 뿐입니다.

계속하려면 **추가 정보** → **실행**을 누르세요. 한 번 누르면 Windows가 선택을 기억합니다.

파일이 진짜인지 확인하고 싶다면 릴리스 페이지의 **SHA-256 체크섬**과 비교하세요:

```powershell
Get-FileHash .\ZTO Setup <version>.exe -Algorithm SHA256
```

⚠️ ZTO는 **위 릴리스 페이지에서만** 받으세요. 다른 곳에서 받은 파일은 신뢰하지 마세요.

---

## 데이터는 어디에 있나

전부 이 컴퓨터 안에만 있습니다. ZTO에는 서버가 없습니다.

| 무엇 | 어디 |
|---|---|
| 계정 메타·앱 답안 시트·스토어 스냅샷 | `~/Library/Application Support/zto/` (Windows: `%APPDATA%\zto\`) |
| 비밀번호 **암호화 키** | OS 키체인 (macOS Keychain / Windows DPAPI) |
| 비밀번호 암호문 | 같은 폴더의 `zto-secrets.json` — 키 없이는 못 읽습니다 |
| AI 대화 | 설정한 provider로 직접 전송. 구독(CLI) 방식이면 이 컴퓨터를 벗어나지 않습니다 |

비밀번호 조회는 **매번 Touch ID**를 지나고, 복사한 값은 30초 뒤 클립보드에서 지워집니다.
자세한 정책과 한계는 앱 안 **계정 인벤토리 → 보안** 패널에 전부 공개돼 있습니다.

---

## 개발

**Node 22.12 필요** (`.tool-versions`로 고정 — asdf 사용).

```bash
npm install
npm run dev          # 개발 실행
npm run typecheck    # 타입 검사
npm run build        # 번들
```

⚠️ `src/main/`·`src/preload/` 변경은 HMR이 안 됩니다 — **dev 서버를 재시작**하세요.
안 하면 새 renderer + 옛 main이 섞여 빈 화면류 버그가 납니다.

### 패키징

```bash
npm run dist:mac     # dmg + zip (arm64 · x64)
npm run dist:win     # nsis 설치 파일
```

macOS 서명·공증에는 키체인의 **Developer ID Application** 인증서와 아래 환경변수가 필요합니다:

```bash
export APPLE_ID="..."                     # Apple Developer 계정
export APPLE_APP_SPECIFIC_PASSWORD="..."  # appleid.apple.com에서 발급
export APPLE_TEAM_ID="..."                # developer.apple.com 멤버십
```

Windows 인증서가 생기면 `CSC_LINK`·`CSC_KEY_PASSWORD`를 넣으면 서명됩니다 —
그때 위 SmartScreen 안내는 지워야 합니다.
