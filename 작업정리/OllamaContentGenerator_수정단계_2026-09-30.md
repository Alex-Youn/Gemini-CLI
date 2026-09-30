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

**수정 파일:** `ollamaContentGenerator.ts`, `ollamaContentGenerator.test.ts`

| 할 일          | 내용                                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 요청 도구 변환 | `functionDeclarations` → `tools`, `parametersJsonSchema` 그대로 / Gemini `Schema` 재귀 변환(대문자 type, `nullable`, int64 문자열 → 숫자, `propertyOrdering` 제거) / 함수 아닌 도구 제외 + 디버그 로그 / `mode: NONE`이면 `tools` 생략 |
| 기록 변환      | `functionCall` → assistant `tool_calls`(arguments 객체) / `functionResponse` → `{role:'tool', tool_name, content}`를 같은 Content의 텍스트보다 먼저 / 병렬 호출 순서 유지                                                              |
| 응답 변환      | `tool_calls` → `functionCall`(Ollama id 우선, 없으면 생성)                                                                                                                                                                             |
| 단위 테스트    | 도구 호출 왕복(요청 → 응답 → 기록 → 다음 요청), 병렬 호출 2개, `Schema` 변환                                                                                                                                                           |

**검증 (GPU 서버 `qwen3-coder:30b` 필수 - 7b는 `tool_calls`를 못 냄):** 먼저
설계문서 10절 측정 2를 30B로 재실행해 `id`·`arguments` 형식과 본문 텍스트 혼입을
확인. 이어서 한 대화에서 파일 읽기 → 설명, 쉘 명령 실행, 파일 한 개 수정 성공.
도구 호출이 본문 텍스트(`<tool_call>` 등)로 나오는 빈도 기록 (자주 나오면 보조
파서 추가를 별도 결정). 429·5xx 반복 시 화면에 Gemini 모델 전환 표시가 나오지
않는지 확인.

## 3단계: 컨텍스트 한도·압축

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

## 선택 (필요할 때만)

| 파일                                   | 내용                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cli/src/ui/privacy/PrivacyNotice.tsx` | OLLAMA면 구글 약관 대신 "로컬 Ollama 사용" 안내 - 지금은 기본값으로 구글 무료 약관 화면이 뜸 |
| `core/src/telemetry/metrics.ts`        | `getGenAiProvider()` OLLAMA 분기 - 사용 통계를 끄면 영향 없음                                |
| `cli/src/ui/auth/AuthDialog.tsx`       | `/auth` 선택 창에 Ollama 항목 추가                                                           |
