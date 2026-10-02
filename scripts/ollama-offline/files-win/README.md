# gemini-cli-ollama (폐쇄망용, Windows x64)

Gemini CLI v0.61.0 포크를 사용자 PC에서 실행하는 패키지입니다. 인터넷 없이
설치·실행합니다. Node 런타임(`runtime\node\node.exe`)이 들어 있어 PC에 Node를
따로 설치할 필요가 없습니다.

```
사용자 PC [VS Code 터미널 + gemini] --HTTP 9300--> REST API [/ollama 중계] --> Ollama qwen3-coder:30b
```

## 설치

1. zip을 원하는 폴더에 풉니다(예: `C:\Tools\gemini-cli-ollama`). 경로에 공백이
   없는 곳을 권장합니다.
2. 푼 폴더에서 `install.cmd`를 실행합니다.
3. `config\gemini-env.cmd`에서 GPU 서버 주소를 고칩니다.
4. `bin` 폴더를 사용자 PATH에 추가하고 터미널을 새로 엽니다.

`install.cmd`가 하는 일: `config\gemini-env.cmd` 생성,
`%USERPROFILE%\.gemini\settings.json`·`GEMINI.md`(한국어 응답 지시)가 없으면
샘플 복사(있으면 그대로 둠), `gemini --version` 실행 확인.

파일 무결성은 zip과 함께 받은 `.sha256` 값과 비교합니다.

```
certutil -hashfile gemini-cli-ollama-*-win-x64.zip SHA256
```

## 설정

`config\gemini-env.cmd` (영문·ASCII로만 작성합니다 - cmd가 한글 주석을 잘못 읽을
수 있습니다)

| 변수                              | 기본값                         | 설명                                  |
| --------------------------------- | ------------------------------ | ------------------------------------- |
| `GEMINI_OLLAMA_BASE_URL`          | `http://127.0.0.1:9300/ollama` | **GPU 서버 주소로 바꿉니다**          |
| `GEMINI_OLLAMA_MODEL`             | `qwen3-coder:30b`              | 서버에 있는 모델 이름                 |
| `GEMINI_OLLAMA_NUM_CTX`           | `32768`                        | SQL 튜닝 REST API와 같은 값           |
| `GEMINI_OLLAMA_RESPONSE_LANGUAGE` | `ko`                           | 도구 호출 앞뒤 설명까지 한국어로 나옴 |

셸에 이미 설정된 환경변수가 있으면 그 값이 우선합니다.

## 실행

VS Code 터미널(PowerShell 또는 cmd)에서:

```
cd <작업할 폴더>
gemini                          대화형 (처음에 폴더 신뢰 여부를 물음)
gemini -p "질문"                 한 번 실행
```

## 문제가 생기면

| 증상                                    | 확인                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `Ollama 서버(...)에 연결할 수 없습니다` | `curl http://<GPU서버>:9300/ollama/api/version`, `config\gemini-env.cmd`의 주소       |
| `Ollama 요청 실패 (404 /api/chat)`      | 서버 REST API가 중계 기능(`/ollama/api/chat`)이 들어간 jar인지                        |
| `모델 ...이(가) Ollama에 없습니다`      | `curl http://<GPU서버>:9300/ollama/api/tags`에 모델 이름이 있는지                     |
| 인증 방식 선택 창이 뜸                  | `%USERPROFILE%\.gemini\settings.json`의 `security.auth.selectedType`이 `"ollama"`인지 |
| 설명이 영어로 나옴                      | 이미 영어로 진행된 대화를 이어 간 경우입니다. 새 세션으로 시작합니다                  |
