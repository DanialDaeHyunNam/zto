#!/bin/bash
# 소스판을 빌드해 /Applications/"ZTO Source.app"으로 (재)설치한다.
# 공식판(/Applications/ZTO.app, 자동 업데이트)과 한 기기에서 구분되게:
#  - 표시명만 "ZTO Source"로 바꾼다 (CFBundleName은 건드리면 안 된다 —
#    Electron이 헬퍼 앱을 "<CFBundleName> Helper"로 찾아서 실행이 죽는다, 실측)
#  - 아이콘은 검정 기본(공식판만 블루)
#  - plist 수정으로 서명이 깨지므로 ad-hoc 재서명
# 빌드 부산물(release/)은 Spotlight에 유령 ZTO로 잡히므로 끝나면 지운다.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="/Applications/ZTO Source.app"

CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- --arm64 --publish never

pkill -f "ZTO Source.app/Contents/MacOS" 2>/dev/null || true
rm -rf "$APP"
cp -R release/mac-arm64/ZTO.app "$APP"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string "ZTO Source"' "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName "ZTO Source"' "$APP/Contents/Info.plist"
codesign --force -s - "$APP"
rm -rf release

echo "✓ ZTO Source 업데이트 완료 → $APP"
