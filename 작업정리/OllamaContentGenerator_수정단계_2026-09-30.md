# OllamaContentGenerator 수정 단계 정리 (2026-09-30)

기준: `설계문서/OllamaContentGenerator_2026-09-30.md` (검토 반영본) 원칙:
단계마다 **빌드·단위 테스트·실측 검증을 통과한 뒤 커밋**하고 다음 단계로
넘어간다. 수정한 원본 파일 머리에는 `// (2026-09 폐쇄망 포크) ...` 한 줄을
넣는다(Apache-2.0).

공통 명령 (작업 폴더 루트):

| 용도             | 명령                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| core 타입 검사   | `npm run typecheck --workspace @google/gemini-cli-core`                      |
| core 단위 테스트 | `npm run test --workspace @google/gemini-cli-core -- ollamaContentGenerator` |
| 전체 빌드        | `npm run build`                                                              |
| 실행             | `npm run start -- -p "안녕"`                                                 |

## 0단계: 준비 (코드 수정 없음)

| #   | 할 일                                                                                                                                           | 완료 기준             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 0-1 | ~~폐쇄망 GPU 서버 `ollama --version` 확인~~ **완료(2026-09-30): `0.35.0`** - 의존 기능 조건 만족                                                | 설계문서 2절에 기록됨 |
| 0-2 | ~~설계문서 9절 미결 2건 결정~~ **완료(2026-09-30)**: 연결 거부 즉시 실패, `tokenLimit` 출력 여유분 4096 차감                                    | 9절에 결정 기록됨     |
| 0-3 | 작업 브랜치 생성(예: `feature/ollama`)                                                                                                          | `master`는 설계문서만 |
| 0-4 | ~~Ollama 0.35.0 동작 실측(로컬 7b)~~ **완료(2026-09-30)**: 헤더는 첫 조각과 함께 옴, `tool_name` 전달 동작, 7b는 도구 호출을 본문 텍스트로 출력 | 설계문서 10절         |

개발 모델: 로컬 PC(GPU 12GB)는 `qwen2.5-coder:7b`로 개발·단위 테스트·1단계
텍스트 대화까지. **1단계 첫 적재 시간과 2단계 이후 완료 판정은 GPU 서버
`qwen3-coder:30b`로** 한다(설계문서 7절).

## 1단계: 설정·인증 연결 + 텍스트 대화

**진행 상황 (2026-09-30, 브랜치 `feature/ollama`):** 구현·단위 테스트 47건·전체
빌드 통과, 로컬 7b 실측 완료(설계문서 10절). 전체 테스트(Windows): core 37건·cli
16건 실패는 **원본 코드에서도 같은 파일·같은 건수로 실패**(심볼릭
링크·샌드박스·Windows 셸·확장 관리 등, 이번 수정과 무관). 신규 파일은 계획 외
`ollamaConfig.ts`(환경변수 읽기) 1개 추가 - `tokenLimits.ts`가 생성기 파일을
가져오면 순환 참조가 생겨 분리. 남은 것은 아래 검증의 대화형 항목과 30B 항목.

**신규 파일**

| 파일                                                    | 내용                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/core/ollamaContentGenerator.ts`      | 클래스 뼈대 + 설정 읽기(`GEMINI_OLLAMA_*`) / 역할별 모델 선택(3.1) / 텍스트 메시지 변환(`systemInstruction`, `text`, `thought` 버림, `inlineData` 대체 문구) / 생성 옵션 변환 + `format`(JSON 모드) / 전용 `undici.Agent` dispatcher + 첫 조각·조각 간 타임아웃 + `abortSignal` 결합 / NDJSON 파서 → `GenerateContentResponse`(`setPrototypeOf`) / `done_reason` → `finishReason`, `usageMetadata` / `countTokens`(추정 함수) / `embedContent`(미지원 오류) / 오류 처리(3.5: 404는 `status` 없이, 연결 거부·DNS 실패는 `code`·`cause` 없이 즉시 실패) |
| `packages/core/src/core/ollamaContentGenerator.test.ts` | `fetch` 모킹: 텍스트 스트림 조각, `done` 없이 끊김 → 오류, `done_reason` 매핑, JSON 모드 `format`, 404·429·5xx·스트림 `{"error"}`, 취소, 연결 거부 오류가 `isRetryableError()`에서 false                                                                                                                                                                                                                                                                                                                                                              |

**기존 파일 수정**

| 파일                                | 수정                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/src/core/contentGenerator.ts` | `AuthType.OLLAMA = 'ollama'` / `getAuthTypeFromEnv()` 맨 앞에 `GEMINI_OLLAMA_BASE_URL` 확인 / `createContentGeneratorConfig()`에서 OLLAMA면 keytar 조회 전에 반환 / `createContentGenerator()`에 `new LoggingContentGenerator(new OllamaContentGenerator(...), gcConfig)` 분기 (fake 응답 분기 다음, `getVersion`·`resolveModel` 앞) |
| `core/src/core/tokenLimits.ts`      | `GEMINI_OLLAMA_BASE_URL`이 있으면 `GEMINI_OLLAMA_NUM_CTX - 4096` 반환                                                                                                                                                                                                                                                                |
| `core/src/index.ts`                 | `export * from './core/ollamaContentGenerator.js'`                                                                                                                                                                                                                                                                                   |
| `cli/src/config/auth.ts`            | `validateAuthMethod()`에 OLLAMA 분기: `BASE_URL`·`MODEL` 없으면 안내 문구                                                                                                                                                                                                                                                            |
| `cli/src/ui/auth/useAuth.ts`        | `selectedType`이 비어 있고 `GEMINI_OLLAMA_BASE_URL`이 있으면 OLLAMA 사용                                                                                                                                                                                                                                                             |
| `core/src/utils/errorParsing.ts`    | `getRateLimitMessage()`에 OLLAMA 분기 - 지금은 기본값이 "Switching to the gemini-flash model" 문구라 오해 소지                                                                                                                                                                                                                       |

**검증** (컨테이너 `rockylinux9`, Ollama `qwen3-coder:30b`)

- [x] `gemini -p "안녕"` 응답 (로컬 7b)
- [ ] 대화형에서 스트리밍 표시, ESC 취소
- [ ] `ollama stop qwen3-coder:30b` 후 첫 요청이 60초를 넘겨도 끊기지 않음 (첫
      조각까지 걸린 시간 기록) - 가짜 서버 70초 지연으로는 통과, 30B 실측 남음
- [x] JSON 모드: `GEMINI_MODEL=auto`로 라우터 분류 호출 통과 (로컬 7b, 스키마
      변환 추가 후)
- [ ] `/compress`로 요약 호출(`UTILITY_COMPRESSOR`) 동작
- [ ] 설정 `selectedType`이 비어 있을 때 인증 선택 창이 뜨지 않음
- [x] `GEMINI_OLLAMA_BASE_URL`을 없는 포트로 바꾸면 재시도 없이 바로 안내 문구
      표시 (없는 모델도 확인)

## 2단계: 도구 호출

**진행 상황 (2026-09-30):** 구현·단위 테스트(누계 75건)·빌드 통과. 로컬 PC
`qwen3-coder:30b`로 아래 검증 통과(설계문서 10절). 계획과 다른 점: ① 도구 결과가
`{output}`·`{error}` 하나면 JSON으로 감싸지 않고 문자열 그대로 보냄(설계문서
3.2절) ② CLI 실제 요청에서 본문 텍스트 도구 호출이 잦아(10회 중 4회) **보조 파서
추가(2026-09-30 오케스트레이터 결정)** - 신규 `ollamaTextToolCalls.ts`.

**수정 파일:** `ollamaContentGenerator.ts`, `ollamaContentGenerator.test.ts`,
신규 `ollamaTextToolCalls.ts`·`ollamaTextToolCalls.test.ts`

| 할 일          | 내용                                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 요청 도구 변환 | `functionDeclarations` → `tools`, `parametersJsonSchema` 그대로 / Gemini `Schema` 재귀 변환(대문자 type, `nullable`, int64 문자열 → 숫자, `propertyOrdering` 제거) / 함수 아닌 도구 제외 + 디버그 로그 / `mode: NONE`이면 `tools` 생략 |
| 기록 변환      | `functionCall` → assistant `tool_calls`(arguments 객체) / `functionResponse` → `{role:'tool', tool_name, content}`를 같은 Content의 텍스트보다 먼저 / 병렬 호출 순서 유지                                                              |
| 응답 변환      | `tool_calls` → `functionCall`(Ollama id 우선, 없으면 생성)                                                                                                                                                                             |
| 단위 테스트    | 도구 호출 왕복(요청 → 응답 → 기록 → 다음 요청), 병렬 호출 2개, `Schema` 변환                                                                                                                                                           |

**검증 (`qwen3-coder:30b` 필수 - 7b는 `tool_calls`를 못 냄):**

- [x] 측정 2를 30B로 재실행: `tool_calls`·`id`·객체 `arguments` 확인 (본문 혼입
      없음)
- [x] 한 대화에서 파일 읽기 → 설명, 쉘 명령 실행, 파일 한 개 수정 성공 (로컬 PC,
      요청 5회·오류 0)
- [x] 도구 호출이 본문 텍스트로 나온 빈도: 단순 API 요청(도구 1개)은 13회 중
      0회지만, **CLI 실제 요청(도구 15개, 입력 약 1.1만 토큰)은 10회 중 4회**
      본문 텍스트로 나옴. 모델이 여는 태그 `<tool_call>`만 빠뜨리고 나머지
      XML(`<function=…><parameter=…>…</parameter></function></tool_call>`)은
      정상 → Ollama 파서가 인식 못 함. → 보조 파서 추가 후 **CLI 10회 중 10회
      성공**(그중 2회는 본문 텍스트로 왔고 모두 복구됨)
- [x] PowerShell에서 실행: 읽기 → 셸 → 수정 3단계 작업 성공(17.5초)
- [x] 429 반복 시 Gemini 모델 전환 없음 (10회 재시도 후 오류 종료). 5xx는 같은
      `status` 경로라 단위 테스트로만 확인
- [ ] 대상 컨테이너(`rockylinux9`)·GPU 서버에서 같은 검증 재실행 (4단계 반입 후)

## 3단계: 컨텍스트 한도·압축

**진행 상황 (2026-09-30): 코드 수정 없이 설정값 확정.** `compressionThreshold`
**0.7**, `truncateToolOutputThreshold` **16000**, `tools.exclude` 웹 도구 2개 -
설계문서 5절 초안 그대로 실측 근거 확보(설계문서 10절).

- [x] 압축 동작: `--resume`으로 3턴 대화(임계값 0.2로 강제) → 2턴 시작에
      `utility_compressor` 호출, 입력 16,978 → 3,078로 줄어듦. 3턴에서 파일을
      다시 읽지 않고 네 파일의 marker를 모두 맞힘(압축 후 내용 유지).
      잘림(`truncated = 1`) 0회
- [x] 도구 출력 한도: 60,054자 파일을 셸로 출력 → 16000이면 입력 +6,084(한도의
      60%까지), 원본 기본 40000이면 +14,953(**26,143 = 한도 28,672의 91%**, 다음
      한 턴도 어려움). 끝부분이 보존돼 마지막 줄은 둘 다 맞힘
- [x] `tools.exclude`: 도구 15 → 13개 확인
- [ ] 대화형에서 긴 대화 압축 빈도 기록 (오케스트레이터 확인 - 대화형은 매 응답
      실측값을 쓰므로 `--resume` 시험보다 일찍 압축됨)

- 기본 부하 실측(로컬 30B, 첫 요청 `prompt_eval_count`): 기본 승인 모드(도구
  8개) **8,777**, yolo(도구 15개) **11,233** = 시스템 프롬프트 6,133(30,285자) +
  도구 정의 4,860 + 첫 사용자 메시지 240. 도구별 상위: `replace` 991,
  `grep_search` 735, `run_shell_command` 558. 폐쇄망에서 못 쓰는
  `google_web_search`(103)·`web_fetch`(225)는 빼도 약 330뿐 - 큰 몫은 시스템
  프롬프트.
- **압축은 사용자 턴 사이에서만 일어난다(원본 동작).**
  `findCompressSplitPoint`가 사용자 텍스트 턴에서만 기록을 자를 수 있어, 한 요청
  안의 도구 반복(모델 → 도구 결과 → 모델…)은 아무리 길어도 압축되지
  않는다(NOOP). 실측: `-p` 한 번으로 파일 6개를 읽자 입력이 11,465 → 29,207까지
  늘었고 압축 없음(잘림도 없음). 한 턴 안의 넘침은 원본의 도구 출력
  마스킹·`ContextWindowWillOverflow`(예상 요청이 남은 한도보다 크면 턴 중단)가
  막는다.
- **이어 하기(`--resume`) 직후 첫 판단은 추정치를 쓴다.** 프로세스를 새로 띄우면
  `lastPromptTokenCount`가 기록만의 추정치(`estimateTokenCountSync`)로 시작해
  시스템 프롬프트·도구(약 1.1만)가 빠진다. 대화형으로 계속 쓰는 경우는 매 응답의
  실측값을 쓰므로 해당 없음.
- 설정 파일 주의: `GEMINI_CLI_SYSTEM_SETTINGS_PATH`로 준 파일은 상위 폴더 권한
  검사에 걸려 무시될 수 있다(`Security Warning: Skipping system settings file`).
  시험에는 `GEMINI_CLI_HOME`(그 아래 `.gemini/settings.json`)을 썼다.

**수정 파일:** 없음 (설정 조정 위주, 필요 시 `tokenLimits.ts`만)

| 할 일          | 내용                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| 기본 부하 실측 | 첫 요청의 `prompt_eval_count`(도구 정의 + 시스템 프롬프트) 기록                                      |
| 압축 설정 조정 | `model.compressionThreshold`(초안 0.7), `tools.truncateToolOutputThreshold`(초안 16000) 실측 후 확정 |
| 필요 시        | 안 쓰는 도구 `tools.exclude`, 또는 `num_ctx` 상향(GPU 메모리 확인, SQL 튜닝 REST API와 같이 변경)    |

**검증:** 긴 대화에서 압축 동작, Ollama 로그에 `truncating input prompt` 없음,
압축 빈도 기록.

## 4단계: 폐쇄망 패키지

| 할 일 | 내용                                                                      |
| ----- | ------------------------------------------------------------------------- |
| 묶음  | `runtime/node` + 빌드 결과 + `settings.json`·`.env` 샘플 → tar            |
| 문서  | 반입·설치 절차서(`작업정리/`), 설정 샘플 최종본은 설계문서 5절과 일치시킴 |

**검증:** 인터넷 없는 컨테이너에서 압축 풀고 1·2단계 검증 항목 재실행.

**진행 상황 (2026-09-30):** 완료. 절차서
`작업정리/폐쇄망_반입설치절차_2026-09-30.md`.

- 만들기: `scripts/ollama-offline/package.sh` →
  `dist-offline/gemini-cli-ollama-<버전>-<커밋>-linux-x64.tar.gz`(약 69MB,
  `.gitignore`에 추가). `npm run bundle` 번들 + 공식 Node v24.19.0
  linux-x64(SHA256 확인, 대상에 xz가 없어 gzip으로 변환) + `rg-linux-x64`(번들
  복사 스크립트가 빠뜨려 따로 넣음) + 실행기·설치 스크립트·설정 샘플
- 검증: `scripts/ollama-offline/verify-docker.sh` - Docker `--internal`
  망(인터넷 차단)의 Rocky 9.3 컨테이너에서 설치·실행
  - [x] 인터넷 차단 확인, 시스템 Node 없이 설치·실행
  - [x] 텍스트 대화, 도구 호출(읽기 → 셸 → 수정), `grep_search`(ripgrep), 연결
        실패 즉시 안내
  - [ ] 실제 폐쇄망 GPU 서버에서 절차서 6절 재실행
- 발견: 127.0.0.1에만 열린 Ollama는 다른 호스트 이름(`Host: ollama`)으로 온
  요청을 403으로 막는다. 검증용 중계는 Host 헤더를 바꿔 해결했고, 다른 서버에서
  CLI를 쓸 때는 `OLLAMA_HOST=0.0.0.0`이 필요하다고 절차서에 적음

## 선택 (필요할 때만)

| 파일                                   | 내용                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cli/src/ui/privacy/PrivacyNotice.tsx` | OLLAMA면 구글 약관 대신 "로컬 Ollama 사용" 안내 - 지금은 기본값으로 구글 무료 약관 화면이 뜸 |
| `core/src/telemetry/metrics.ts`        | `getGenAiProvider()` OLLAMA 분기 - 사용 통계를 끄면 영향 없음                                |
| `cli/src/ui/auth/AuthDialog.tsx`       | `/auth` 선택 창에 Ollama 항목 추가                                                           |
