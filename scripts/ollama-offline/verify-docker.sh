#!/bin/bash
# (2026-09 폐쇄망 포크) 폐쇄망 패키지 검증 - 인터넷이 막힌 Docker 내부망에서 설치·실행해 본다.
#
#   bash scripts/ollama-offline/verify-docker.sh [패키지.tar.gz] [이미지] [모델]
#
# 구성:
#   gemini-closed (docker network --internal, 인터넷·호스트 접근 없음)
#     ├─ gemini-ollama-relay : 기본 bridge에도 붙어 host.docker.internal:11434(호스트 Ollama)로 중계, 별칭 "ollama"
#     └─ 검증 컨테이너       : gemini-closed에만 붙음 → Ollama(중계)만 보이고 인터넷은 안 보임
set -uo pipefail
# Git Bash가 /bin/sh, /dist 같은 컨테이너 경로를 Windows 경로로 바꾸지 않게 한다.
export MSYS_NO_PATHCONV=1

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PKG=${1:-$(ls -t "$ROOT"/dist-offline/gemini-cli-ollama-*-linux-x64.tar.gz | head -1)}
IMAGE=${2:-rockylinux9_rag:latest}
MODEL=${3:-qwen3-coder:30b}
NET=gemini-closed
RELAY=gemini-ollama-relay
PKG_DIR=$(cd "$(dirname "$PKG")" && pwd -W 2>/dev/null || pwd)
PKG_FILE=$(basename "$PKG")

echo "패키지: $PKG_FILE"
echo "이미지: $IMAGE, 모델: $MODEL"

cleanup() {
  docker rm -f "$RELAY" > /dev/null 2>&1
  docker network rm "$NET" > /dev/null 2>&1
}
trap cleanup EXIT
cleanup
docker network create --internal "$NET" > /dev/null

# 중계 컨테이너: 패키지 안의 Node로 HTTP 중계 (이미지에 Node가 없어도 됨).
# 호스트 Ollama가 127.0.0.1에만 열려 있으면 Host 헤더가 "ollama"인 요청을 403으로 막으므로 Host를 바꿔 보낸다.
RELAY_JS="const h=require('http');h.createServer((q,s)=>{const u=h.request({host:'host.docker.internal',port:11434,method:q.method,path:q.url,headers:{...q.headers,host:'host.docker.internal:11434'}},r=>{s.writeHead(r.statusCode,r.headers);r.pipe(s);});u.on('error',e=>{s.writeHead(502);s.end(String(e));});q.pipe(u);}).listen(11434,()=>console.log('relay ready'))"
docker run -d --name "$RELAY" --entrypoint /bin/sh -v "$PKG_DIR:/dist:ro" "$IMAGE" -c "
  mkdir -p /tmp/p /tmp/node && tar -xzf /dist/$PKG_FILE -C /tmp/p &&
  tar -xzf /tmp/p/gemini-cli-ollama/runtime/node-v*-linux-x64.tar.gz -C /tmp/node --strip-components=1 &&
  exec /tmp/node/bin/node -e \"$RELAY_JS\"" > /dev/null
docker network connect --alias ollama "$NET" "$RELAY"
for _ in $(seq 1 30); do
  docker logs "$RELAY" 2>&1 | grep -q "relay ready" && break
  sleep 1
done

docker logs "$RELAY" 2>&1 | grep -q "relay ready" || { echo "중계 컨테이너 시작 실패:"; docker logs "$RELAY"; exit 1; }

# 검증 컨테이너
docker run --rm --network "$NET" --entrypoint /bin/bash \
  -v "$PKG_DIR:/dist:ro" -e MODEL="$MODEL" -e PKG_FILE="$PKG_FILE" "$IMAGE" -c '
set -u
pass=0; fail=0
check() { if [ "$1" = 0 ]; then echo "  [통과] $2"; pass=$((pass+1)); else echo "  [실패] $2"; fail=$((fail+1)); fi; }

echo "== 1. 폐쇄망 확인"
curl -s -m 5 -o /dev/null https://nodejs.org; [ $? -ne 0 ]; check $? "인터넷 차단 (nodejs.org 접속 불가)"
curl -s -m 5 http://ollama:11434/api/version | grep -q version; check $? "Ollama 중계 접속 (http://ollama:11434)"

echo "== 2. 설치"
mkdir -p /opt && tar -xzf /dist/$PKG_FILE -C /opt && cd /opt/gemini-cli-ollama
sh install.sh > /tmp/install.log 2>&1; check $? "install.sh"
sed -n "1,40p" /tmp/install.log | sed "s/^/    /"
export PATH=/opt/gemini-cli-ollama/bin:$PATH
export GEMINI_OLLAMA_BASE_URL=http://ollama:11434 GEMINI_OLLAMA_MODEL=$MODEL GEMINI_MODEL=$MODEL
[ "$(command -v node || true)" = "" ]; check $? "시스템 Node 없이 실행 (패키지 런타임만 사용)"
/opt/gemini-cli-ollama/bundle/vendor/ripgrep/rg-linux-x64 --version | head -1 | grep -q ripgrep; check $? "번들 ripgrep 실행"

echo "== 3. 텍스트 대화"
mkdir -p /work && cd /work
out=$(timeout 600 gemini --skip-trust -p "한 문장으로 자기소개 해 주세요." 2>/tmp/t3.err); rc=$?
echo "    응답: $(echo "$out" | tail -1 | cut -c1-120)"
[ $rc = 0 ] && [ -n "$out" ]; check $? "gemini -p 응답"

echo "== 4. 도구 호출 (읽기 → 셸 → 수정)"
printf "Shopping list\n- apple 3\n- milk 1\n" > notes.txt
out=$(timeout 900 gemini --skip-trust --approval-mode yolo -p "1) notes.txt를 읽고 내용을 한 줄로 설명 2) 셸 명령으로 현재 폴더 파일 목록 확인 3) notes.txt에서 apple 3을 banana 5로 수정. 마지막에 한 일을 요약해 주세요." 2>/tmp/t4.err); rc=$?
echo "$out" | tail -6 | sed "s/^/    /"
grep -q "banana 5" notes.txt; check $? "notes.txt 수정됨 (exit $rc)"

echo "== 5. grep_search (ripgrep)"
out=$(timeout 600 gemini --skip-trust -p "grep_search 도구로 이 폴더에서 milk가 들어 있는 파일과 줄을 찾아 알려 주세요." 2>/tmp/t5.err); rc=$?
echo "    응답: $(echo "$out" | tail -2 | tr "\n" " " | cut -c1-160)"
echo "$out" | grep -qi "notes.txt"; check $? "grep_search 결과에 notes.txt (exit $rc)"

echo "== 6. 연결 실패 안내"
start=$(date +%s)
out=$(GEMINI_OLLAMA_BASE_URL=http://ollama:1999 timeout 120 gemini --skip-trust -p hi 2>&1)
secs=$(( $(date +%s) - start ))
echo "$out" | grep -q "연결할 수 없습니다"; check $? "재시도 없이 안내 문구 (${secs}초)"

echo
echo "결과: 통과 $pass, 실패 $fail"
[ $fail = 0 ]
'
rc=$?
echo "검증 컨테이너 종료 코드: $rc"
exit $rc
