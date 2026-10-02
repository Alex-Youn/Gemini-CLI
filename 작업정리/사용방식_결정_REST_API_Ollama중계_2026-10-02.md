# 사용 방식 결정: 로컬 PC CLI → REST API(Ollama 중계) → Ollama (2026-10-02)

`작업정리/사용방식_웹연동_검토_2026-10-01.md` 5절 "결정할 것"에 대한
오케스트레이터 결정과, 그에 따라 REST API에 추가한 Ollama 중계 엔드포인트 기록.

## 1. 결정

```
로컬 PC [VS Code + Gemini CLI] --HTTP 9300--> REST API [/ollama/api/chat 중계] --localhost:11434--> Ollama qwen3-coder:30b
```

- CLI는 사용자 PC에서 실행한다(VS Code 터미널). 도구는 PC의 파일을 다룬다.
- GPU 서버 쪽은 기존 REST API(`SqltuneRestApi`, 9300)를 Ollama 입구로 쓴다.
  Ollama(11434)는 열지 않는다.
- 개발 PC에서는 Docker `rockylinux9` 컨테이너가 GPU 서버 역할을 한다(REST
  API·Ollama·모델 모두 컨테이너 안).
- 검토 문서 4-1절 "선택지 추가 - 기존 REST API를 Ollama 입구로 사용"과 같은
  구성이다.

## 2. REST API 변경 (Gemini-CLI 저장소 밖)

위치: 컨테이너 `/SqltuneRestApi/app/sqlrestapi` 파일:
`src/main/java/com/dbagent/sqltune/controller/OllamaProxyController.java` (새
파일, 기존 파일 수정 없음)

| 경로                      | 동작                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `POST /ollama/api/chat`   | 요청 본문을 그대로 Ollama `/api/chat`에 전달, 응답(NDJSON)을 읽는 대로 흘려보냄 |
| `GET /ollama/api/version` | 연결 확인용                                                                     |
| `GET /ollama/api/tags`    | 모델 목록 확인용                                                                |

- 기존 `POST /api/chat`(프롬프트 조립형 프록시, `{prompt, promptId}` →
  `{answer}`)과 경로가 겹쳐서 `/ollama` 아래에 두었다.
- Ollama 주소는 기존 설정 `sqltune.llm.url`을 쓴다. 모델·`num_ctx`·도구 선언은
  CLI가 보낸 값 그대로다 (`sqltune.llm.model`과 무관).
- 스트리밍: 서블릿 응답에 직접 쓰고 조각마다 flush. Spring 비동기 처리를 쓰지
  않아 30초 비동기 타임아웃이 없다.
- 취소: CLI가 연결을 끊으면 upstream을 닫아 Ollama도 생성을 멈춘다(Ollama 로그
  `cancel task` 확인).
- 오류: Ollama에 연결하지 못하면 502와 `{"error": "..."}`(Ollama 오류 형식).
- 중계하지 않는 것: 모델 내려받기·삭제 등 관리용 API, 임베딩(CLI가 호출하지
  않음).
- 인증 없음(기존 REST API와 같음). 필요하면 별도 결정.

빌드·기동(컨테이너 안):

```sh
/SqltuneRestApi/app/start_ollama.sh
cd /SqltuneRestApi/app/sqlrestapi && ./build.sh && ./start_server_prod.sh
curl http://localhost:9300/ollama/api/version
```

교체 전 jar 백업: 컨테이너 `/tmp/sqltune-rag-java.jar.bak-20261002`

## 3. CLI 쪽

코드 수정 없음. 주소만 바꾼다(CLI는 주소 뒤에 `/api/chat`을 붙인다).

```
GEMINI_OLLAMA_BASE_URL=http://<서버>:9300/ollama
```

`scripts/gemini-ollama.ps1`의 기본값을 `http://127.0.0.1:9300/ollama`로 바꿨다.

## 4. 확인 (개발 PC, 2026-10-02)

| 항목                                                         | 결과                                       |
| ------------------------------------------------------------ | ------------------------------------------ |
| 호스트에서 `GET /ollama/api/version`, `/ollama/api/tags`     | 정상(Ollama 0.33.3, `qwen3-coder:30b`)     |
| `POST /ollama/api/chat` 스트리밍                             | 200 `application/x-ndjson`, 조각 단위 수신 |
| CLI `-p`로 도구 2회 호출(list_directory, read_file) 후 답변  | 정상                                       |
| 클라이언트 중단 시 Ollama 생성 중지                          | 정상                                       |
| 한국어 문답 삽입(`GEMINI_OLLAMA_RESPONSE_LANGUAGE=ko`) 첫 턴 | 15/15 한국어(미적용 0/12)                  |

- 한 번은 첫 설명이 중국어로 나왔다(다른 질문, 이후 턴은 한국어). 드물게 남을 수
  있다.
- 대화형 화면(스트리밍 표시, ESC 취소)은 확인하지 않았다.

## 5. 사용자 PC용 Windows 패키지

`scripts/ollama-offline/package.sh`에 `--target win-x64`를 추가했다(기본값은
기존 `linux-x64`).

```
gemini-cli-ollama-<버전>-<커밋>-win-x64.zip  (약 47MB, 풀면 약 144MB)
  bin\gemini.cmd                 실행기 (cmd만 사용 - PowerShell 실행 정책과 무관)
  install.cmd                    설정 샘플 복사, 실행 확인
  bundle\                        CLI 번들 + vendor\ripgrep\rg-win32-x64.exe
  runtime\node\node.exe          Node 런타임 (npm 등은 넣지 않음)
  config\gemini-env.cmd.sample   서버 주소·모델·num_ctx·응답 언어
  config\settings.json.sample, config\GEMINI.md.sample
  README.md, VERSION, SHA256SUMS
```

- 파일: `scripts/ollama-offline/files-win/` (설정 샘플 두 개는 `files/config/`의
  것을 같이 씀)
- cmd 배치 파일은 영문·ASCII로만 썼다(cmd가 OEM 코드 페이지로 읽어 한글 주석이
  깨질 수 있음). 저장소에는 LF로 들어가고 패키지를 만들 때 CRLF로 바꾼다.
- `package.sh`가 번들 전에 core를 빌드하도록 고쳤다(안 하면 core 소스 수정이
  번들에서 빠짐).

만드는 순서 (인터넷망 PC, Git Bash + Node 설치 필요):

```sh
git pull
npm ci
bash scripts/ollama-offline/package.sh --target win-x64     # 사용자 PC용 zip
bash scripts/ollama-offline/package.sh --skip-bundle        # 서버용 tar.gz가 필요하면 (같은 번들 재사용)
```

`dist-offline/`에 생긴 zip과 `.sha256`을 폐쇄망으로 반입한다. 패키지에 들어가는
Node 버전은 만드는 PC의 `node --version`과 같다(`--node-version`으로 지정 가능).

확인 (개발 PC, 2026-10-02): 공백·괄호가 있는 경로(`win test (x86)`)에 풀어
`install.cmd` 실행, 두 번째 실행 시 기존 설정 유지, PATH에 `bin`을 넣고
PowerShell에서 `gemini -p "한글 질문"` 실행 (REST API 중계 경유, 검색 도구 포함)
모두 정상.

확인하지 않은 것: 새로 clone한 저장소에서 `npm ci`부터 하는 전체 과정, cmd
창에서의 대화형 화면, VS Code 연동 확장.

## 6. 남은 일

- PC의 `C:\AI-Projects\SqlRestApi` 소스는 컨테이너보다
  오래됐다(`OllamaService`의 num_ctx, `OpenSearchIndexerService`의 UTF-8 수정이
  없음). 새 컨트롤러 파일만 복사해 두었다. 어느 쪽도 git 관리가 아니다.
- 컨테이너를 재시작하면 Ollama·REST API를 다시 띄워야 한다.
- 폐쇄망 GPU 서버의 REST API에 같은 컨트롤러 반영(재빌드·반입).
- 인터넷망 PC에서 Windows 패키지를 만들어 폐쇄망 사용자 PC로 반입·설치·검증.
- GPU 서버 2대 분산, 인증 여부.
