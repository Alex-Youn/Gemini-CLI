#!/bin/bash
# (2026-09 폐쇄망 포크) 폐쇄망 반입용 패키지 만들기 - 인터넷 되는 PC에서 실행 (Git Bash 또는 Linux)
#
#   bash scripts/ollama-offline/package.sh [--skip-bundle] [--node-version v24.19.0]
#
# 결과: dist-offline/gemini-cli-ollama-<버전>-<커밋>-linux-x64.tar.gz
#   gemini-cli-ollama/
#     bin/gemini                      실행기
#     install.sh                      설치 (Node 런타임 풀기, 설정 샘플 복사)
#     bundle/                         CLI 번들 + vendor/ripgrep/rg-linux-x64
#     runtime/node-<버전>-linux-x64.tar.gz
#     config/gemini.env.sample, config/settings.json.sample
#     README.md, VERSION, SHA256SUMS
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/scripts/ollama-offline"
OUT="$ROOT/dist-offline"
CACHE="$OUT/cache"
NODE_VERSION=$(node --version)
SKIP_BUNDLE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-bundle) SKIP_BUNDLE=1 ;;
    --node-version) NODE_VERSION="$2"; shift ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT"
CLI_VERSION=$(node -p "require('./package.json').version")
COMMIT=$(git rev-parse --short HEAD)
DIRTY=$(git status --porcelain -- packages scripts | grep -q . && echo "-dirty" || true)
NAME="gemini-cli-ollama-${CLI_VERSION}-${COMMIT}${DIRTY}-linux-x64"
NODE_DIST="node-${NODE_VERSION}-linux-x64"

echo "[1/5] CLI 번들"
if [ "$SKIP_BUNDLE" = 0 ]; then
  rm -rf bundle
  npm run bundle > "$OUT.bundle.log" 2>&1 || { echo "번들 실패 - $OUT.bundle.log" >&2; exit 1; }
  rm -f "$OUT.bundle.log"
fi
[ -f bundle/gemini.js ] || { echo "bundle/gemini.js 없음" >&2; exit 1; }

echo "[2/5] Node 런타임 ${NODE_VERSION} (linux-x64)"
mkdir -p "$CACHE"
if [ ! -f "$CACHE/${NODE_DIST}.tar.gz" ]; then
  base="https://nodejs.org/dist/${NODE_VERSION}"
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
cp -r "$HERE/files/." "$STAGE/"
cp -r bundle/. "$STAGE/bundle/"
cp packages/core/vendor/ripgrep/rg-linux-x64 "$STAGE/bundle/vendor/ripgrep/"
cp "$CACHE/${NODE_DIST}.tar.gz" "$STAGE/runtime/"
# Windows에서 만들어도 셸 스크립트가 Linux에서 돌도록 줄바꿈을 LF로 맞춘다.
for f in bin/gemini install.sh config/gemini.env.sample; do
  sed -i 's/\r$//' "$STAGE/$f"
done
cat > "$STAGE/VERSION" <<EOF
gemini-cli ${CLI_VERSION} (폐쇄망 Ollama 포크)
commit ${COMMIT}${DIRTY} ($(git log -1 --format=%cd --date=iso))
node ${NODE_VERSION} linux-x64
built $(date '+%Y-%m-%d %H:%M:%S %z')
EOF

echo "[4/5] SHA256SUMS"
(cd "$STAGE" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs sha256sum > SHA256SUMS)

echo "[5/5] tar.gz"
# Windows에서는 실행 권한이 기록되지 않으므로 install.sh가 chmod 한다.
tar --owner=0 --group=0 -czf "$OUT/${NAME}.tar.gz" -C "$OUT/stage" gemini-cli-ollama
rm -rf "$OUT/stage"
(cd "$OUT" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256")

echo
echo "완료: dist-offline/${NAME}.tar.gz ($(du -h "$OUT/${NAME}.tar.gz" | cut -f1))"
cat "$OUT/${NAME}.tar.gz.sha256"
