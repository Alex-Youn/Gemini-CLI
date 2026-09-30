#!/bin/sh
# (2026-09 폐쇄망 포크) gemini-cli-ollama 설치 - 압축을 푼 폴더에서 한 번 실행한다. 인터넷 불필요.
#   sh install.sh
set -e

cd "$(dirname "$(readlink -f "$0")")"
PKG_DIR=$(pwd)

echo "[1/4] 파일 무결성 확인 (SHA256SUMS)"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --quiet -c SHA256SUMS
  echo "      OK"
else
  echo "      sha256sum이 없어 건너뜀"
fi

echo "[2/4] Node 런타임 풀기 (runtime/node)"
if [ ! -x runtime/node/bin/node ]; then
  tarball=$(ls runtime/node-v*-linux-x64.tar.gz)
  mkdir -p runtime/node
  tar -xzf "$tarball" -C runtime/node --strip-components=1
fi
chmod +x bin/gemini bundle/vendor/ripgrep/rg-linux-x64
echo "      $(runtime/node/bin/node --version)"

echo "[3/4] 설정 파일"
if [ ! -f config/gemini.env ]; then
  cp config/gemini.env.sample config/gemini.env
  echo "      config/gemini.env 생성 - Ollama 주소·모델을 확인하세요"
else
  echo "      config/gemini.env 유지"
fi
mkdir -p "$HOME/.gemini"
if [ -f "$HOME/.gemini/settings.json" ]; then
  echo "      기존 $HOME/.gemini/settings.json 유지 - config/settings.json.sample과 비교해 필요한 항목을 옮기세요"
else
  cp config/settings.json.sample "$HOME/.gemini/settings.json"
  echo "      $HOME/.gemini/settings.json 생성"
fi

echo "[4/4] 실행 확인"
echo "      gemini $(bin/gemini --version)"

echo
echo "설치 완료. PATH에 추가하세요 (예: ~/.bashrc):"
echo "  export PATH=\"$PKG_DIR/bin:\$PATH\""
