# (2026-09 폐쇄망 포크) 개발 PC(Windows PowerShell)용 gemini-cli-ollama 실행기
# 이 저장소의 번들(bundle/gemini.js)을 로컬 Ollama로 실행한다. 리눅스 반입본의 bin/gemini에 해당.
#   cd <작업할 폴더>
#   C:\AI-Projects\Gemini-CLI\scripts\gemini-ollama.ps1              # 대화형
#   C:\AI-Projects\Gemini-CLI\scripts\gemini-ollama.ps1 -p "질문"    # 한 번 실행
# 인자는 모두 gemini에 그대로 넘긴다(그래서 이 스크립트에는 param 블록을 두지 않는다).

$RepoDir = Split-Path -Parent $PSScriptRoot
$Bundle = Join-Path $RepoDir 'bundle\gemini.js'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'node를 찾을 수 없습니다. Node.js 20 이상을 설치하세요.'
  exit 1
}
if (-not (Test-Path $Bundle)) {
  Write-Error "번들이 없습니다: $Bundle`n먼저 빌드하세요: cd $RepoDir; npm run bundle"
  exit 1
}

# GEMINI_OLLAMA_* 기본값 (셸에 이미 있는 값이 우선) - scripts/ollama-offline/files/config/gemini.env.sample과 같은 값
function Set-DefaultEnv([string]$Name, [string]$Value) {
  if (-not [Environment]::GetEnvironmentVariable($Name, 'Process')) {
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
  }
}

# Ollama 주소. REST API(SqltuneRestApi, Docker rockylinux9의 9300)의 /ollama 중계를 거쳐 컨테이너 Ollama로 간다.
# 폐쇄망과 같은 구성이다(GPU 서버는 9300만 열림). 컨테이너에서 Ollama와 REST API가 떠 있어야 한다.
# Windows Ollama로 바로 붙으려면: $env:GEMINI_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
# (localhost:11434는 리스너가 여럿이라 쓰지 않는다)
Set-DefaultEnv 'GEMINI_OLLAMA_BASE_URL' 'http://127.0.0.1:9300/ollama'

# 대화용 모델 (ollama list로 확인)
Set-DefaultEnv 'GEMINI_OLLAMA_MODEL' 'qwen3-coder:30b'

# 화면 하단 모델 표시. auto로 두면 매 턴 라우터 호출이 추가돼 느려진다.
Set-DefaultEnv 'GEMINI_MODEL' $env:GEMINI_OLLAMA_MODEL

# 컨텍스트 길이. SQL 튜닝 REST API와 같은 값으로 맞춘다(다르면 모델을 다시 적재함).
Set-DefaultEnv 'GEMINI_OLLAMA_NUM_CTX' '32768'

# 답변 언어. 도구 호출 앞뒤 설명까지 한국어로 나오게 한다(GEMINI.md 지시만으로는 영어가 섞임). 지원 값: ko
Set-DefaultEnv 'GEMINI_OLLAMA_RESPONSE_LANGUAGE' 'ko'

# 대화 요청의 temperature. CLI 기본값(1)에서는 답변이 가끔 중국어·일본어로 나온다.
Set-DefaultEnv 'GEMINI_OLLAMA_TEMPERATURE' '0.3'

# 선택 항목 (쓰려면 주석을 푼다)
# Set-DefaultEnv 'GEMINI_OLLAMA_FAST_MODEL' 'qwen3-coder:30b'   # 압축·요약 등 유틸리티 호출용 (GPU 1장이면 비워 두기)
# Set-DefaultEnv 'GEMINI_OLLAMA_EMBED_MODEL' 'bge-m3'           # 임베딩용 모델
# Set-DefaultEnv 'GEMINI_OLLAMA_KEEP_ALIVE' '30m'               # 모델을 메모리에 유지하는 시간
# Set-DefaultEnv 'GEMINI_OLLAMA_TIMEOUT_SECONDS' '600'          # 첫 조각까지·조각 사이 최대 대기

if ($MyInvocation.ExpectingInput) {
  $input | & node $Bundle @args
} else {
  & node $Bundle @args
}
exit $LASTEXITCODE
