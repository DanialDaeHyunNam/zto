#!/bin/bash
# 설치된 ZTO를 **샌드박스 프로필**로 한 벌 더 띄운다 — 스크린샷·데모 영상·실험용.
#
# 진짜 데이터는 건드리지 않는다. 파일을 바꿔치기하면 그 앱은 진짜 데이터를 못 켜고
# 실수 하나가 원본을 덮으므로, 방을 하나 더 쓰는 쪽을 택했다:
#   진짜  → <userData>/
#   샌드박스 → <userData>/profiles/<이름>/
# 앱이 `--profile=<이름>`을 보고 userData를 그쪽으로 돌린다(src/main/index.ts 맨 위).
# 라이선스만은 진짜 폴더를 계속 본다 — 자격은 기기에 붙는 것이지 데이터 방에 붙지 않는다.
#
#   npm run demo:profile                  # 샌드박스로 한 벌 더 실행 (진짜 앱과 동시에 떠 있어도 된다)
#   npm run demo:profile -- --reset       # 샘플 계정으로 초기화하고 실행
#   npm run demo:profile -- --name shots  # 다른 이름의 방
#   npm run demo:profile -- --dev         # 설치된 앱 대신 `npm run dev`용 방에 씨앗만
set -euo pipefail

NAME="demo"
RESET=""
DEV=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --reset) RESET=1; shift ;;
    --dev) DEV=1; shift ;;   # 설치된 앱 대신 `npm run dev`용 방에 씨앗을 심는다
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

SAMPLE="$(cd "$(dirname "$0")" && pwd)/demo-accounts.sample.json"

# 공식 빌드는 `ZTO`, 소스·dev 빌드는 `ZTO-dev` (src/main/index.ts의 ① 참조)
APPDIR="ZTO"; [[ -n "$DEV" ]] && APPDIR="ZTO-dev"
case "$(uname -s)" in
  Darwin) ROOT="$HOME/Library/Application Support/$APPDIR" ;;
  Linux)  ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/$APPDIR" ;;
  *)      ROOT="${APPDATA:-$HOME/AppData/Roaming}/$APPDIR" ;;
esac
DIR="$ROOT/profiles/$NAME"
mkdir -p "$DIR"

# 씨앗은 계정 목록 하나뿐 — 나머지(스토어 캐시·자격증명)는 앱에서 평소처럼 채운다.
# 비밀번호는 여기 못 넣는다(OS 키체인으로 암호화된다) — 앱에서 저장하면 이 방에만 쌓인다.
if [[ -n "$RESET" || ! -f "$DIR/zto-accounts.json" ]]; then
  cp "$SAMPLE" "$DIR/zto-accounts.json"
  echo "✓ Sample accounts seeded."
fi
echo "  Profile data: $DIR"

if [[ -n "$DEV" ]]; then
  echo "Now run:  ZTO_PROFILE=$NAME npm run dev"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Launch your ZTO build with:  --profile=$NAME   (or ZTO_PROFILE=$NAME)"
  exit 0
fi

APP=""
for candidate in "/Applications/ZTO.app" "/Applications/ZTO Source.app"; do
  [[ -d "$candidate" ]] && { APP="$candidate"; break; }
done
if [[ -z "$APP" ]]; then
  echo "✋ No installed ZTO found in /Applications."
  echo "   For a dev run instead:  ZTO_PROFILE=$NAME npm run dev"
  exit 1
fi

# -n = 새 인스턴스. 진짜 데이터로 띄운 앱과 나란히 떠 있을 수 있다(서로 다른 폴더를 본다)
open -na "$APP" --args --profile="$NAME"
echo "✓ Launched $(basename "$APP") on profile \"$NAME\"."
