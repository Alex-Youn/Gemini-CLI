#!/bin/bash
# (2026-09 폐쇄망 포크) 폐쇄망 반입용 패키지 만들기 - 인터넷 되는 PC에서 실행 (Git Bash 또는 Linux)
#
#   bash scripts/ollama-offline/package.sh [--target linux-x64|win-x64] [--skip-bundle] [--node-version v24.19.0]
#
# 결과 (--target linux-x64, 기본값 - 서버용): dist-offline/gemini-cli-ollama-<버전>-<커밋>-linux-x64.tar.gz
#   gemini-cli-ollama/
#     bin/gemini                      실행기
#     install.sh                      설치 (Node 런타임 풀기, 설정 샘플 복사)
#     bundle/                         CLI 번들 + vendor/ripgrep/rg-linux-x64
#     runtime/node-<버전>-linux-x64.tar.gz
#     config/gemini.env.sample, config/settings.json.sample
#     README.md, VERSION, SHA256SUMS
#
# 결과 (--target win-x64 - 사용자 PC용): dist-offline/gemini-cli-ollama-<버전>-<커밋>-win-x64.zip
#   gemini-cli-ollama/
#     bin/gemini.cmd                  실행기
#     install.cmd                     설치 (설정 샘플 복사, 실행 확인)
#     bundle/                         CLI 번들 + vendor/ripgrep/rg-win32-x64.exe
#     runtime/node/node.exe
#     config/gemini-env.cmd.sample, config/settings.json.sample, config/GEMINI.md.sample
#     README.md, VERSION, SHA256SUMS
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/scripts/ollama-offline"
OUT="$ROOT/dist-offline"
CACHE="$OUT/cache"
NODE_VERSION=$(node --version)
SKIP_BUNDLE=0
TARGET=linux-x64

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-bundle) SKIP_BUNDLE=1 ;;
    --target) TARGET="$2"; shift ;;
    --node-version) NODE_VERSION="$2"; shift ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$TARGET" in
  linux-x64|win-x64) ;;
  *) echo "지원하지 않는 --target: $TARGET (linux-x64, win-x64)" >&2; exit 2 ;;
esac

cd "$ROOT"
CLI_VERSION=$(node -p "require('./package.json').version")
COMMIT=$(git rev-parse --short HEAD)
# 추적 중인 파일의 수정만 본다(테스트가 만든 추적 안 된 파일은 번들에 들어가지 않음).
DIRTY=$(git status --porcelain --untracked-files=no -- packages scripts | grep -q . && echo "-dirty" || true)
NAME="gemini-cli-ollama-${CLI_VERSION}-${COMMIT}${DIRTY}-${TARGET}"
NODE_DIST="node-${NODE_VERSION}-${TARGET}"

echo "[1/5] CLI 번들"
if [ "$SKIP_BUNDLE" = 0 ]; then
  rm -rf bundle
  # 번들은 packages/core/dist를 읽는다. core를 먼저 빌드하지 않으면 core 소스 수정이 빠진다.
  { npm run build --workspace=@google/gemini-cli-core && npm run bundle; } > "$OUT.bundle.log" 2>&1 \
    || { echo "빌드·번들 실패 - $OUT.bundle.log" >&2; exit 1; }
  rm -f "$OUT.bundle.log"
fi
[ -f bundle/gemini.js ] || { echo "bundle/gemini.js 없음" >&2; exit 1; }

echo "[2/5] Node 런타임 ${NODE_VERSION} (${TARGET})"
mkdir -p "$CACHE"
base="https://nodejs.org/dist/${NODE_VERSION}"
if [ "$TARGET" = win-x64 ]; then
  if [ ! -f "$CACHE/${NODE_DIST}.zip" ]; then
    curl -fsSL -o "$CACHE/${NODE_DIST}.zip.part" "$base/${NODE_DIST}.zip"
    curl -fsSL -o "$CACHE/SHASUMS256-${NODE_VERSION}.txt" "$base/SHASUMS256.txt"
    mv "$CACHE/${NODE_DIST}.zip.part" "$CACHE/${NODE_DIST}.zip"
    (cd "$CACHE" && grep " ${NODE_DIST}.zip\$" "SHASUMS256-${NODE_VERSION}.txt" | sha256sum -c -) \
      || { rm -f "$CACHE/${NODE_DIST}.zip"; exit 1; }
  fi
elif [ ! -f "$CACHE/${NODE_DIST}.tar.gz" ]; then
  curl -fsSL -o "$CACHE/${NODE_DIST}.tar.xz" "$base/${NODE_DIST}.tar.xz"
  curl -fsSL -o "$CACHE/SHASUMS256-${NODE_VERSION}.txt" "$base/SHASUMS256.txt"
  (cd "$CACHE" && grep " ${NODE_DIST}.tar.xz\$" "SHASUMS256-${NODE_VERSION}.txt" | sha256sum -c -)
  # 대상 서버에 xz가 없을 수 있어 gzip으로 바꾼다. 풀지 않고 스트림으로 바꿔 실행 권한이 그대로 남는다.
  xz -dc "$CACHE/${NODE_DIST}.tar.xz" | gzip -9 > "$CACHE/${NODE_DIST}.tar.gz"
fi

echo "[3/5] 패키지 폴더 구성"
STAGE="$OUT/stage/gemini-cli-ollama"
rm -rf "$OUT/stage"
mkdir -p "$STAGE/runtime" "$STAGE/bundle/vendor/ripgrep"
cp -r bundle/. "$STAGE/bundle/"
if [ "$TARGET" = win-x64 ]; then
  cp -r "$HERE/files-win/." "$STAGE/"
  cp "$HERE/files/config/settings.json.sample" "$HERE/files/config/GEMINI.md.sample" "$STAGE/config/"
  cp packages/core/vendor/ripgrep/rg-win32-x64.exe "$STAGE/bundle/vendor/ripgrep/"
  # node.exe만 있으면 된다(npm 등은 넣지 않는다). 미리 풀어 넣어 PC에서 압축 도구가 필요 없게 한다.
  mkdir -p "$STAGE/runtime/node"
  unzip -q -j "$CACHE/${NODE_DIST}.zip" "${NODE_DIST}/node.exe" "${NODE_DIST}/LICENSE" -d "$STAGE/runtime/node"
  # 저장소에는 LF로 들어 있다(.gitattributes). cmd 배치 파일은 CRLF여야 안전하다.
  for f in bin/gemini.cmd install.cmd config/gemini-env.cmd.sample; do
    sed -i 's/\r$//; s/$/\r/' "$STAGE/$f"
  done
else
  cp -r "$HERE/files/." "$STAGE/"
  cp packages/core/vendor/ripgrep/rg-linux-x64 "$STAGE/bundle/vendor/ripgrep/"
  cp "$CACHE/${NODE_DIST}.tar.gz" "$STAGE/runtime/"
  # Windows에서 만들어도 셸 스크립트가 Linux에서 돌도록 줄바꿈을 LF로 맞춘다.
  for f in bin/gemini install.sh config/gemini.env.sample; do
    sed -i 's/\r$//' "$STAGE/$f"
  done
fi
cat > "$STAGE/VERSION" <<EOF
gemini-cli ${CLI_VERSION} (폐쇄망 Ollama 포크)
commit ${COMMIT}${DIRTY} ($(git log -1 --format=%cd --date=iso))
node ${NODE_VERSION} ${TARGET}
built $(date '+%Y-%m-%d %H:%M:%S %z')
EOF

echo "[4/5] SHA256SUMS"
(cd "$STAGE" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs sha256sum > SHA256SUMS)

if [ "$TARGET" = win-x64 ]; then
  echo "[5/5] zip"
  ARCHIVE="${NAME}.zip"
  rm -f "$OUT/$ARCHIVE"
  if command -v zip > /dev/null 2>&1; then
    (cd "$OUT/stage" && zip -q -r "$OUT/$ARCHIVE" gemini-cli-ollama)
  elif [ -x /c/Windows/System32/tar.exe ]; then
    # Git Bash에는 zip이 없다. Windows에 들어 있는 tar(bsdtar)는 확장자를 보고 zip으로 묶는다.
    (cd "$OUT/stage" && /c/Windows/System32/tar.exe -a -c -f "../$ARCHIVE" gemini-cli-ollama)
  else
    echo "zip 또는 Windows tar.exe가 필요합니다" >&2; exit 1
  fi
else
  echo "[5/5] tar.gz"
  ARCHIVE="${NAME}.tar.gz"
  # Windows에서는 실행 권한이 기록되지 않으므로 install.sh가 chmod 한다.
  tar --owner=0 --group=0 -czf "$OUT/$ARCHIVE" -C "$OUT/stage" gemini-cli-ollama
fi
rm -rf "$OUT/stage"
(cd "$OUT" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256")

echo
echo "완료: dist-offline/$ARCHIVE ($(du -h "$OUT/$ARCHIVE" | cut -f1))"
cat "$OUT/$ARCHIVE.sha256"
