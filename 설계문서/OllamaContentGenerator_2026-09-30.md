# OllamaContentGenerator 설계 (2026-09-30)

폐쇄망에서 Gemini CLI(v0.61.0 포크)를 GPU 서버의 Ollama(`qwen3-coder:30b`)로
동작시키기 위한 설계. 대상 기능: 대화(스트리밍), 에이전트 도구(파일 읽기·쓰기·쉘
등), 대화 압축·요약 같은 내부 유틸리티 호출. 제외: 구글 로그인, 웹
검색(`googleSearch`), URL 컨텍스트(`urlContext`), 컨텍스트 캐시, 이미지 입력.

## 1. 끼워 넣는 위치

모든 모델 호출은 `ContentGenerator`
인터페이스(`packages/core/src/core/contentGenerator.ts:39`) 하나를 거친다. 생성
지점도 `createContentGenerator()` 한 곳(`config.ts:1612`에서만 호출)이므로,
**구현체 하나를 추가하고 분기만 늘린다.** 호출하는 쪽(메인 대화 `geminiChat.ts`,
압축, 요약, 토큰 계산 등 20여 곳)은 수정하지 않는다.

```
createContentGenerator(authType = 'ollama')
  └─ LoggingContentGenerator            (기존 - 로그·텔레메트리 래퍼, 그대로 사용)
       └─ OllamaContentGenerator        (신규)
            └─ fetch → Ollama /api/chat (NDJSON 스트림), /api/embed
```

`ModelMappingContentGenerator`는 쓰지 않는다. 모델 이름 바꾸기는 신규 구현체가
직접 한다(3.1절).

## 2. 설정 (환경변수)

| 변수                            | 기본값                  | 설명                                                                                                                                      |
| ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GEMINI_OLLAMA_BASE_URL`        | (필수)                  | 예: `http://localhost:11434`. **설정의 `selectedType`이 비어 있을 때** 이 값이 있으면 인증 방식을 `ollama`로 자동 선택                    |
| `GEMINI_OLLAMA_MODEL`           | (필수)                  | 예: `qwen3-coder:30b`. 모든 요청의 모델을 이 값으로 바꿈                                                                                  |
| `GEMINI_OLLAMA_FAST_MODEL`      | = `GEMINI_OLLAMA_MODEL` | 유틸리티 호출(압축·요약·라우터 등)용. GPU 1장이면 **비워 두는 것을 권장**(모델 2개를 번갈아 올리면 느려짐)                                |
| `GEMINI_OLLAMA_NUM_CTX`         | 32768                   | 모든 요청의 `options.num_ctx`. CLI의 컨텍스트 한도(`tokenLimit`)는 이 값 - 4096(출력 여유분, 9절 결정 2)                                  |
| `GEMINI_OLLAMA_EMBED_MODEL`     | (없음)                  | 임베딩용. 없으면 `embedContent`는 미지원 오류                                                                                             |
| `GEMINI_OLLAMA_KEEP_ALIVE`      | (Ollama 기본)           | 요청의 `keep_alive`(예: `30m`)                                                                                                            |
| `GEMINI_OLLAMA_TIMEOUT_SECONDS` | 600                     | **첫 조각까지의 대기**(모델 적재·프롬프트 처리 포함) 및 **조각 사이 최대 공백**. 전체 응답 시간 상한이 아님(긴 답변이 중간에 잘리지 않게) |

- **접두어 `GEMINI_OLLAMA_`로 확정(2026-09-30 오케스트레이터 결정).** 이유:
  `OLLAMA_HOST`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_CONTEXT_LENGTH` 등은 **Ollama
  서버가 읽는 환경변수**다. CLI와 `ollama serve`가 같은 서버·같은 셸 프로파일에
  있으면 이름이 겹쳐 서로 영향을 준다.
- **num_ctx는 SQL 튜닝 REST API와 같은 값(32768)으로 맞춘다.** Ollama는 같은
  모델이라도 `num_ctx`가 다른 요청이 오면 모델을 **다시 적재**한다. 두
  클라이언트가 값이 다르면 번갈아 호출될 때마다 30B 모델을 다시 올리게 된다.
- `.env`(작업 폴더 또는 `~/.gemini/.env`)에도 둘 수 있다. 기존 CLI가 `.env`를
  읽는 방식을 그대로 따른다.
- **자동 선택 우선순위:** 설정 파일의 `security.auth.selectedType`이
  환경변수보다 우선한다 (비대화형 `validateNonInterActiveAuth.ts:27`
  `configuredAuthType || getAuthTypeFromEnv()`, 대화형 `useAuth.ts`는 설정값만
  봄). 예전에 `oauth-personal` 등이 저장돼 있으면 `GEMINI_OLLAMA_BASE_URL`은
  무시되므로 5절 샘플처럼 `"ollama"`를 명시한다.
- **Ollama 버전: 폐쇄망 GPU 서버 `0.35.0` (2026-09-30 확인).** 설계가 의존하는
  도구 호출 스트리밍, tool 메시지의 `tool_name`, `message.thinking`, JSON 스키마
  `format`은 모두 이보다 앞선 버전에서 들어온 기능이라 조건을 만족한다. 0.35.0
  세부 동작 실측은 10절에 기록한다. 헤더 시점·`tool_name`
  전달·`prompt_eval_count` 의미는 확인됨, `tool_calls`의 `id` 제공 여부는
  qwen3-coder:30b로 확인 예정.

## 3. OllamaContentGenerator (신규 `packages/core/src/core/ollamaContentGenerator.ts`)

### 3.1 모델 선택

- `req.model`(Gemini 이름)은 **무시**하고 세 번째 인자 `role: LlmRole`로 고른다.
  - `MAIN`, `SUBAGENT` → `GEMINI_OLLAMA_MODEL`
  - `UTILITY_*`(압축·요약·라우터·루프 감지 등 10종, `telemetry/llmRole.ts`) →
    `GEMINI_OLLAMA_FAST_MODEL`
  - `FAST_MODEL`에 생각(thinking) 모델(예: `qwen3`)을 쓰면 유틸리티 호출에는
    `think:false`를 넣는다(지연 감소). `qwen3-coder`는 해당 없음.
- 이유: 내부 유틸리티 호출은 `gemini-*-flash-lite` 같은 이름을 쓰는데, 이름
  매핑표를 두면 원본 버전이 올라갈 때마다 깨진다.

### 3.2 요청 변환 (Gemini `GenerateContentParameters` → Ollama `/api/chat`)

**메시지 (`contents` + `config.systemInstruction`)**

| Gemini                                          | Ollama                                                                                                                                                                                                                                                                             | 비고                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `systemInstruction` (문자열·`Content`·`Part[]`) | 맨 앞 `{role:'system', content}`                                                                                                                                                                                                                                                   | 텍스트만 이어 붙임                                                              |
| `role:'user'`의 `text` 파트                     | `{role:'user', content}`                                                                                                                                                                                                                                                           | 한 Content의 텍스트 여러 개는 줄바꿈으로 연결                                   |
| `role:'user'`의 `functionResponse` 파트         | 파트마다 `{role:'tool', tool_name: name, content}`. `content`는 `response`가 `{output}` 하나면 그 문자열, `{error}` 하나면 `Error: …`, 그 밖에는 `JSON.stringify(response)` (2단계 구현 - JSON으로 감싸면 파일 내용의 줄바꿈·따옴표가 이스케이프돼 토큰이 늘고 모델이 읽기 어려움) | 같은 Content 안의 텍스트보다 **먼저** 넣음(직전 assistant의 tool_calls 바로 뒤) |
| `role:'model'`의 `text` 파트(`thought` 아님)    | `{role:'assistant', content}`                                                                                                                                                                                                                                                      |                                                                                 |
| `role:'model'`의 `functionCall` 파트            | 같은 assistant 메시지의 `tool_calls:[{function:{name, arguments: args}}]`                                                                                                                                                                                                          | `arguments`는 **객체 그대로**(OpenAI와 달리 문자열 아님)                        |
| `thought:true` 파트, `thoughtSignature`         | 버림                                                                                                                                                                                                                                                                               | Gemini 전용                                                                     |
| `inlineData`, `fileData`                        | 텍스트 `[첨부 생략: <mimeType>]`                                                                                                                                                                                                                                                   | qwen3-coder는 이미지 입력 없음                                                  |
| `contents`가 문자열·단일 Content·`Part[]`       | `Content[]`로 정규화 후 위 규칙                                                                                                                                                                                                                                                    | SDK 타입 `ContentListUnion`                                                     |

**도구 (`config.tools`, `config.toolConfig`)**

- `functionDeclarations[]` →
  `tools:[{type:'function', function:{name, description, parameters}}]`
  - `parametersJsonSchema`가 있으면 그대로, `parameters`(Gemini `Schema`)면 JSON
    Schema로 변환: `type` 대문자 enum(`OBJECT`, `STRING` …) → 소문자, `nullable`
    → `type` 배열 등 재귀 변환. Gemini `Schema`의 int64 필드(`minItems`,
    `maxItems`, `minLength`, `maxLength`, `minProperties`, `maxProperties`)는
    **문자열**로 오므로 숫자로 바꾸고, Gemini 전용 `propertyOrdering`은 뺀다.
    (기본 도구 대부분은 `parametersJsonSchema`를 써서 우선순위는 낮음)
- `googleSearch`, `urlContext`, `codeExecution` 등 함수 선언이 아닌 도구 →
  **빼고** 디버그 로그만 남김.
- `toolConfig.functionCallingConfig.mode === 'NONE'` → `tools`를 보내지 않음.
  `ANY`(강제 호출)는 Ollama에 대응 옵션이 없어 무시.

**생성 옵션 (`config` → `options`)**

| Gemini                                                                           | Ollama `options`                              |
| -------------------------------------------------------------------------------- | --------------------------------------------- |
| (항상)                                                                           | `num_ctx` = `GEMINI_OLLAMA_NUM_CTX`           |
| `temperature`, `topP`, `topK`, `seed`                                            | `temperature`, `top_p`, `top_k`, `seed`       |
| `maxOutputTokens`                                                                | `num_predict`                                 |
| `stopSequences`                                                                  | `stop`                                        |
| `presencePenalty`, `frequencyPenalty`                                            | `presence_penalty`, `frequency_penalty`       |
| `responseMimeType:'application/json'` + `responseJsonSchema`/`responseSchema`    | 최상위 `format`: 스키마 객체(없으면 `'json'`) |
| `thinkingConfig`, `candidateCount`, `cachedContent`, `labels`, `mediaResolution` | 무시                                          |
| `abortSignal`                                                                    | `fetch`의 `signal`(타임아웃 신호와 합침)      |

유틸리티 호출(`BaseLlmClient.generateJson`)이 `responseJsonSchema`로 JSON을
요구하므로 `format` 변환은 1단계부터 필요하다. **`responseJsonSchema`에도 Gemini
`Schema` 변환을 적용한다(1단계 실측).** 라우터
분류(`numericalClassifierStrategy.ts:33`)가 `responseJsonSchema`에 `Type.OBJECT`
같은 대문자 `type`을 넣어, 그대로 보내면 Ollama가
400(`unrecognized type OBJECT`)으로 거부한다. 변환 함수 `toJsonSchema`는 2단계
도구 `parameters` 변환에도 그대로 쓴다.

### 3.3 응답 변환 (Ollama NDJSON → `GenerateContentResponse`)

- **항상 `stream:true`로 요청한다.** `generateContent`(비스트리밍)도 내부적으로
  스트림을 받아 합친다. 이유: 비스트리밍이면 생성이 끝나야 응답 헤더가 오므로 긴
  답변에서 헤더 대기 시간을 넘긴다.
- **`fetch`에 전용 `dispatcher`를 넘긴다:**
  `new undici.Agent({ headersTimeout, bodyTimeout })` (값 =
  `GEMINI_OLLAMA_TIMEOUT_SECONDS`).
  - 이 CLI는 시작 시 undici 전역 설정을 **헤더 60초·본문 조각 간 300초**로
    바꾼다(`core/src/utils/fetch.ts:33-34`, `:216`). Ollama는 **첫 조각을 쓸 때
    헤더를 보낸다(0.35.0 실측 확인, 10절)**. 따라서 스트리밍이어도 **30B 첫
    적재 + 1~2만 토큰 프롬프트 처리**가 60초를 넘으면 끊긴다(30B 소요 시간은 GPU
    서버에서 실측).
  - 기존 `fetchWithTimeout`·`createSafeAgent`는 **사설 IP를
    차단**하므로(`fetch.ts:182`, `:482`) 쓰지 않는다 - localhost·사내 GPU 서버
    주소가 막힌다.
  - 프록시 설정이 있으면 전역 설정이 `EnvHttpProxyAgent`로
    바뀌어(`fetch.ts:515`) `NO_PROXY`가 없을 때 Ollama 요청이 프록시로 나간다.
    전용 `Agent`는 프록시를 거치지 않는다.
  - 타임아웃은 **첫 조각까지 대기 + 조각 사이 공백** 기준으로 건다(전체 시간
    상한 아님). 사용자 취소(`abortSignal`)와 합친다.
- 줄마다 JSON 한 개. 조각별로 `GenerateContentResponse`를 만들어 yield:

| Ollama 조각                        | Gemini 응답                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.content` (빈 문자열 아님) | `candidates[0].content = {role:'model', parts:[{text}]}`                                                                                                         |
| `message.thinking`                 | `parts:[{text, thought:true}]` (생각 표시용, 기록에는 안 남음)                                                                                                   |
| `message.tool_calls[]`             | `parts:[{functionCall:{id, name, args}}]` - Ollama가 `id`를 주면 그대로, 없으면 `ollama-<요청순번>-<n>`으로 생성(없어도 `turn.ts:475`가 만들어 주므로 선택 사항) |
| 마지막 `done:true`                 | `finishReason` + `usageMetadata` (parts는 빈 배열 - `role:'model'` + 빈 parts는 유효 응답으로 처리됨, `geminiChat.ts:160`)                                       |

- `done_reason` → `finishReason`: `stop` → `STOP`, `length` → `MAX_TOKENS`, 그
  밖 → `OTHER`. **마지막 조각에 `finishReason`이 없으면 `geminiChat`이
  `NO_FINISH_REASON` 오류로 재시도한다(`geminiChat.ts:1574`)** - 스트림이 `done`
  없이 끊기면 오류를 던진다.
- `usageMetadata`: `promptTokenCount = prompt_eval_count`,
  `candidatesTokenCount = eval_count`, `totalTokenCount = 합`,
  `cachedContentTokenCount = prompt_eval_cached_count`(있을 때, 10절). CLI는 이
  값(`getLastPromptTokenCount`)으로 대화 압축 시점을 정하므로 **실측값을 반드시
  채운다.**
- 응답 객체는 `Object.setPrototypeOf(obj, GenerateContentResponse.prototype)`로
  만든다(`fakeContentGenerator.ts:123`과 같은 방식 - `.text`, `.functionCalls`
  게터가 동작해야 함).
- `candidates[0].index = 0`, `modelVersion = 실제 Ollama 모델 이름`.

### 3.4 countTokens / embedContent

- `countTokens`: Ollama에 토큰 수 API가 없으므로 기존 추정 함수
  `estimateTokenCountSync`(`utils/tokenCalculation.ts:120`, ASCII 0.33·비ASCII
  1.5토큰/글자)로 계산. 실제 값은 응답의 `prompt_eval_count`가 보정한다.
- `embedContent`: `GEMINI_OLLAMA_EMBED_MODEL`이 있으면
  `POST /api/embed {model, input:[텍스트...]}` → `embeddings`. 없으면 "지원하지
  않음" 오류. (v0.61.0 기준 `BaseLlmClient.generateEmbedding` 호출처가 없어
  우선순위 낮음)

### 3.5 오류 처리

| 상황                          | 처리                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 연결 거부·DNS 실패            | `Ollama 서버(<URL>)에 연결할 수 없습니다 - ollama serve 기동과 GEMINI_OLLAMA_BASE_URL을 확인하세요`. **재시도 없이 즉시 실패**(9절 결정 1). 기존 재시도는 `cause` 사슬의 `code`(`retry.ts:100-116`)와 메시지의 `fetch failed`(`retryFetchErrors` 기본 true, `retry.ts:180`)를 보고 재시도하므로, 새 오류에는 **`code`·`cause`를 넣지 않고 메시지에 `fetch failed`를 쓰지 않는다**(원래 코드는 `(ECONNREFUSED)`처럼 문구에만 표시). 응답 도중 끊김·타임아웃(`ECONNRESET`, `UND_ERR_*`)은 원래 오류를 그대로 던져 기존 재시도를 유지 |
| HTTP 404 + 모델 없음          | `모델 <이름>이 Ollama에 없습니다 - ollama list로 확인하세요`. **`status`를 넣지 않은 일반 오류로 던진다** - status 404는 `classifyGoogleError`(`googleQuotaErrors.ts:242`)가 `ModelNotFoundError`로 바꿔 `handleFallback`(Gemini 대체 모델 전환 흐름)으로 넘어가기 때문                                                                                                                                                                                                                                                            |
| HTTP 429·5xx                  | 오류 객체에 `status`를 넣어 던짐 → 기존 재시도 로직(`utils/retry.ts`, 상태 추출은 `utils/httpErrors.ts:16` `getErrorStatus`)이 그대로 동작                                                                                                                                                                                                                                                                                                                                                                                         |
| 스트림 중 `{"error": ...}` 줄 | 그 메시지로 오류                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 오류 본문 형식                | `{"error":"..."}`와 `{"error":{"message":"..."}}` 둘 다 온다(스키마 오류는 후자, 1단계 실측). 둘 다 메시지만 꺼낸다                                                                                                                                                                                                                                                                                                                                                                                                                |
| 타임아웃·사용자 취소          | `AbortError` 그대로 전달(ESC 취소가 동작해야 함)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 4. 기존 파일 수정 (작은 수정)

| 파일                                | 수정                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/src/core/contentGenerator.ts` | `AuthType.OLLAMA = 'ollama'` 추가. `getAuthTypeFromEnv()` 맨 앞에서 `GEMINI_OLLAMA_BASE_URL` 확인. `createContentGeneratorConfig()`는 OLLAMA면 **API 키 저장소(keytar) 조회 전에 바로 반환** - 원본 주석대로 Docker·SSH 리눅스에서 keytar가 멈출 수 있음. `createContentGenerator()`에 분기 추가                                                                    |
| `core/src/core/tokenLimits.ts`      | `GEMINI_OLLAMA_BASE_URL`이 있으면 `GEMINI_OLLAMA_NUM_CTX`를 한도로 반환(모델 이름이 아닌 환경변수 기준 - 대체 모델 전환으로 이름이 바뀌어도 유지). 지금은 모르는 모델이 **1,048,576**으로 잡혀 압축(기본 한도의 50%)이 시작되기 전에 Ollama가 앞부분을 잘라냄. `num_ctx`는 출력 토큰까지 포함하므로 **출력 여유분 4096을 뺀 값**(32768 → 28,672)을 반환(9절 결정 2) |
| `cli/src/config/auth.ts`            | `validateAuthMethod()`에 OLLAMA: `BASE_URL`과 `MODEL`이 없으면 안내 문구 반환                                                                                                                                                                                                                                                                                       |
| `cli/src/ui/auth/useAuth.ts`        | `selectedType`이 비어 있고 `GEMINI_OLLAMA_BASE_URL`이 있으면 OLLAMA 사용 - 첫 실행 때 인증 선택 창이 안 뜨게                                                                                                                                                                                                                                                        |
| `core/src/index.ts`                 | 필요 시 신규 클래스 export                                                                                                                                                                                                                                                                                                                                          |

수정한 원본 파일 머리에는 `// (2026-09 폐쇄망 포크) ...` 한 줄로 변경
표시(Apache-2.0 조건).

## 5. 설정 파일로 끄는 것 (코드 수정 없음)

`~/.gemini/settings.json` 샘플:

```json
{
  "security": { "auth": { "selectedType": "ollama" } },
  "general": {
    "enableAutoUpdate": false,
    "enableAutoUpdateNotification": false
  },
  "privacy": { "usageStatisticsEnabled": false },
  "model": { "compressionThreshold": 0.7 },
  "tools": {
    "exclude": ["google_web_search", "web_fetch"],
    "truncateToolOutputThreshold": 16000
  }
}
```

- `compressionThreshold` 0.7: 기본 0.5면 32768의 절반(16,384)에서 압축이
  시작된다. 도구 정의·시스템 프롬프트가 약 1만 토큰이면 대화가 약 6천 토큰 쌓일
  때마다 압축 호출(같은 GPU)이 나간다. 0.7이면 한도 28,672(출력 여유분 차감)
  기준 약 20,070에서 시작. **3단계 실측으로 확정(10절).** 기본 부하가 yolo
  11,233 (기본 모드 8,777)이라 0.5(14,336)면 대화 여유가 약 3천 토큰뿐 - 도구
  출력 한 번 (최대 약 6천)도 못 담고 매 턴 압축한다. 0.8(22,937)이면 한도까지 약
  5,700이 남아 한도 16000자 출력 한 번(+6,084 실측)을 못 받는다. 0.7이면
  20,070 + 6,084 = 26,154로 한도 안에 든다.
- `truncateToolOutputThreshold` 16000(글자): **3단계 실측으로 확정(10절).**
  60,054자 출력 기준 기본 40,000이면 입력 +14,953(한도의 91%까지), 16000이면
  +6,084. 앞 20%·뒤 80%를 남기고 자르므로 마지막 부분 질문에는 둘 다 답했다.
- **압축은 사용자 턴 사이에서만 일어난다(원본 동작).** 한 요청 안의 도구 반복은
  압축하지 않고, 넘칠 것 같으면 원본의 도구 출력
  마스킹·`ContextWindowWillOverflow`(턴 중단)가 막는다.
- 웹 검색·웹 가져오기는 Gemini 전용 기능(`defaultModelConfigs.ts:244`
  `googleSearch`, `:252` `urlContext`)이라 도구 목록에서 뺀다.
- 모델은 `GEMINI_MODEL`(또는 `-m`)에 `auto`가 아닌 값을 준다. `auto`면 매 턴
  라우터 분류 호출(`UTILITY_ROUTER`)이 추가로 나가 느려진다. 화면 하단 모델
  표시는 이 값이 보이므로 `GEMINI_MODEL=qwen3-coder:30b`로 맞춘다.

## 6. 위험 요소

| 위험                                                                                                                                                                                              | 대응                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 모델이 도구 호출을 `tool_calls`가 아닌 **본문 텍스트**(`<tool_call>…` 등)로 내보냄 - Ollama 파서가 못 알아본 경우. **qwen2.5-coder:7b에서 실제 발생**(10절: 태그 없는 JSON 본문 + 인자 이름 오류) | **qwen3-coder:30b에서도 발생**(CLI 실제 요청 10회 중 4회, 여는 `<tool_call>`만 빠짐, 10절). **보조 파서 추가(2026-09-30 결정, `ollamaTextToolCalls.ts`)**: 도구를 보낸 요청에서만, 본문의 `<function=이름>…<parameter=키>값</parameter>…</function>`을 찾아 `functionCall`로 바꿈. 요청에 있는 도구 이름만 인정, 값은 도구 스키마 타입(정수·불리언·객체 등)으로 변환. 스트리밍 중 `<function=`·`<tool_call>`부터는 화면에 내보내지 않고 모았다가 끝에서 변환, 해석 못 하면 원문 텍스트로 출력 |
| 도구 정의 + 시스템 프롬프트만으로 수천~1만 토큰 → 32768에서 여유가 적음                                                                                                                           | 3단계에서 첫 요청의 `prompt_eval_count` 실측. 부족하면 `tools.exclude`로 안 쓰는 도구를 빼거나 num_ctx 상향(GPU 메모리 확인 - 32768에서 KV 3,072 MiB)                                                                                                                                                                                                                                                                                                                                         |
| 30B 로컬 모델의 여러 단계 에이전트 작업 품질                                                                                                                                                      | 파일 읽기·설명·단일 파일 수정부터 검증하고 기대 범위를 문서화                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 32768 컨텍스트에서 압축이 잦음 → 매번 유틸리티 호출로 응답 지연                                                                                                                                   | 5절 `compressionThreshold`·`truncateToolOutputThreshold` 조정, 3단계에서 압축 빈도 실측                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ollama 오류가 Gemini 대체 모델 흐름(`handleFallback`)으로 들어가 화면에 Gemini 모델 이름으로 전환 표시                                                                                            | 404는 `status` 없이 던짐(3.5절). 429·5xx 반복 시 전환 여부를 2단계에서 확인                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 첫 적재가 undici 헤더 60초를 넘김                                                                                                                                                                 | 전용 `dispatcher`(3.3절). 헤더가 첫 조각과 함께 온다는 것은 확인됨(10절). 30B 첫 요청 시간은 GPU 서버에서 모델 내린 상태로 실측                                                                                                                                                                                                                                                                                                                                                               |
| 원본 버전 업그레이드 시 충돌                                                                                                                                                                      | 신규 파일 1개 + 작은 수정 4~5곳으로 범위를 제한. `upstream` 원격으로 비교                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 7. 단계별 진행과 검증

| 단계 | 범위                                                                                                         | 검증 (컨테이너 `rockylinux9`, Ollama `qwen3-coder:30b`)                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 설정·인증 연결, 텍스트 대화 스트리밍, `finishReason`·`usageMetadata`, JSON 모드(`format`), 전용 `dispatcher` | `gemini -p "안녕"` 응답, 대화형에서 스트리밍 표시, ESC 취소, 모델 내린 상태에서 첫 요청이 60초를 넘겨도 끊기지 않음, Ollama 버전 기록 |
| 2    | 도구 호출 변환(요청 `tools`, 응답 `tool_calls`, 기록의 `functionCall`/`functionResponse`)                    | 파일 읽기 → 설명, 쉘 명령 실행, 파일 한 개 수정까지 한 대화에서 성공                                                                  |
| 3    | `tokenLimit`, `countTokens`, 대화 압축                                                                       | 긴 대화에서 압축이 동작하고 Ollama 로그에 `truncating input prompt`가 없음                                                            |
| 4    | 폐쇄망 패키지                                                                                                | `runtime/node` + 빌드 결과 + `settings.json`·`.env` 샘플을 tar로 묶고 반입 절차서 작성                                                |

개발 모델: 로컬 PC(GPU 12GB)에서는 `qwen2.5-coder:7b`로 빌드·단위 테스트·1단계
텍스트 대화까지 진행한다. 30B는 12GB에 다 올라가지 않으므로 **1단계 첫 적재
시간, 2단계 이후 완료 판정은 GPU 서버의 `qwen3-coder:30b`로** 한다(7b는 도구
호출을 `tool_calls`로 내보내지 못함, 10절). 모델 전환은
`GEMINI_OLLAMA_MODEL`·`GEMINI_MODEL`만 바꾸면 된다.

단위 테스트(vitest, `fetch` 모킹): 기록 변환(도구 호출 왕복 포함), 스트림 조각 →
응답, `done_reason` 매핑, JSON 모드, 오류 상태 코드(404에 `status` 없음 포함),
`Schema` 변환(int64 문자열 → 숫자).

참고: Qwen Code(`QwenLM/qwen-code`, Gemini CLI 포크, Apache-2.0)의
`OpenAIContentGenerator`가 같은 문제(OpenAI 형식)를 푼 구현이라 변환 경계 사례를
비교할 때 참고한다.

## 8. 검토 반영 이력

| 날짜       | 내용                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-30 | 2단계(도구 호출) 구현·실측 반영(10절): 도구 결과 `{output}`·`{error}`는 문자열 그대로(3.2), 보조 파서 없이 진행, 도구 정의 포함 요청당 입력 약 1.1만 토큰                                                                                                                                          |
| 2026-09-30 | 1단계 구현 실측 반영(10절): `responseJsonSchema`에도 스키마 변환 적용(3.2), 중첩 오류 본문(3.5), `cachedContentTokenCount`(3.3)                                                                                                                                                                    |
| 2026-09-30 | Ollama 0.35.0 실측(로컬, qwen2.5-coder:7b) 기록(10절): 헤더가 첫 조각과 함께 옴 확정, `tool_name` 전달 동작, `prompt_eval_count`는 캐시 포함 전체. 7b 도구 호출 본문 텍스트 문제를 6절에 반영, 개발 모델 방침 7절 추가                                                                             |
| 2026-09-30 | Ollama 서버 버전 `0.35.0` 기록(2절) - 의존 기능 조건 만족                                                                                                                                                                                                                                          |
| 2026-09-30 | 미결 2건 결정(9절): 연결 거부 즉시 실패, `tokenLimit` 출력 여유분 4096 차감                                                                                                                                                                                                                        |
| 2026-09-30 | 코드 대조 검토 반영: undici 헤더 대기 300초 → **60초** 정정(전용 `dispatcher`, 사설 IP 차단·프록시 회피), 404 오류의 대체 모델 흐름 회피, 압축 빈도 대응 설정 추가, 자동 선택 우선순위·Ollama 최소 버전·tool call id·`Schema` 변환·`think:false` 명시, `UTILITY_*` 10종·`getErrorStatus` 위치 정정 |

## 9. 결정 사항 (2026-09-30 오케스트레이터 결정)

| #   | 항목                         | 결정                                                       | 이유                                                                                                                                                            | 반영 위치     |
| --- | ---------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | 연결 거부·DNS 실패 시 재시도 | **즉시 실패** (응답 도중 끊김·타임아웃은 기존 재시도 유지) | 그대로 두면 메인 대화 최대 10회(5→10→20→30초…) 약 3~4분 뒤에야 안내가 보임. 같은 망의 Ollama가 꺼져 있으면 기다려도 살아나지 않는 경우가 대부분                 | 3.5절         |
| 2   | `tokenLimit` 출력 여유분     | **4096 차감** (32768 → 28,672)                             | 입력이 한도 근처면 답변 자리가 없어 Ollama가 앞부분을 밀어내며 생성. 보통 답변·도구 호출 인자에 충분하고, 압축 시작이 약 22,900 → 20,070으로 조금 빨라지는 정도 | 2절, 4절, 5절 |

## 10. 실측 기록

### 2026-09-30 로컬 PC (Ollama `0.35.0` - GPU 서버와 같은 버전, 모델 `qwen2.5-coder:7b`, GPU 12GB, `num_ctx` 32768)

| #   | 측정                                                   | 결과                                                                                                                                                   | 판단                                                                                                                             |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1-A | 모델 내린 상태 + 짧은 질문                             | `HTTP 200` 3.5초, 첫 조각 3.5초                                                                                                                        | **헤더는 첫 조각과 함께 온다(확정)**. 적재·프롬프트 처리 시간이 모두 헤더 대기(60초)에 들어감 → 전용 `dispatcher` 필요           |
| 1-B | 모델 내린 상태 + 약 2만 토큰                           | `HTTP 200` 6.5초, 첫 조각 6.5초                                                                                                                        | 같은 동작. 7b라 60초와 거리가 멀어 **30B 소요 시간은 GPU 서버에서 재측정**                                                       |
| 2   | 도구 호출 (`get_weather`, 인자 `city`)                 | `tool_calls` 없음. 본문(`content`)에 태그 없는 JSON `{"name": "get_weather", "arguments": {"location": "Seoul"}}`를 조각으로 출력, `done_reason: stop` | Ollama 파서가 인식 못 함 + 인자 이름도 틀림(`city` → `location`). **7b로는 2단계 검증 불가.** `id`·`arguments` 형식은 30B로 확인 |
| 3   | 도구 결과 전달 (`tool_name`, `tool_calls`에 `id` 없음) | "The current temperature in Seoul is 21 degrees Celsius with clear skies."                                                                             | 3.2절 기록 변환(`tool_name`, `id` 없는 `tool_calls`)이 0.35.0에서 동작                                                           |

- 마지막 조각 필드: `done_reason`, `total_duration`, `load_duration`,
  `prompt_eval_count`, **`prompt_eval_cached_count`**, `prompt_eval_duration`,
  `eval_count`, `eval_duration`.
- `prompt_eval_count`는 **캐시 적중분을 포함한 전체 입력 토큰**이다(2: 145, 3:
  193 중 캐시 145). 3.3절 `promptTokenCount = prompt_eval_count` 매핑이 압축
  판단에 맞다.
- 30B 재측정 항목(GPU 서버): 1-A·1-B 시간, 2 (`tool_calls` 여부·`id`·`arguments`
  형식·본문 텍스트 혼입), 3.

### 2026-09-30 `qwen3-coder:30b` (로컬 PC, Windows Ollama `0.35.0`, 오케스트레이터 측정 + Claude 재현)

| #   | 측정                                      | 결과                                                                                                                                                                                                                                                                   | 판단                                                                                                                              |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1-A | 모델 내린 상태 + 짧은 질문                | `HTTP 200` 9.4초 = 첫 조각 (적재 약 8.3초)                                                                                                                                                                                                                             | 60초와 거리가 멀다                                                                                                                |
| 1-B | 모델 내린 상태 + 약 2만 토큰              | `HTTP 200` 15.3초 = 첫 조각                                                                                                                                                                                                                                            | 60초 이내. 전용 `dispatcher`는 SQL 튜닝 API와 GPU를 나눠 쓸 때·더 긴 프롬프트·디스크 캐시가 식은 첫 적재에 대비한 안전장치로 유지 |
| 2   | 도구 호출 (오케스트레이터 측정, 스트리밍) | `tool_calls` 없음. 본문에 "I cannot fetch real-time information..." 후 마지막 조각 본문이 `<tool_call>` 한 토큰으로 끝남. **입력 240토큰**                                                                                                                             | 실패. 같은 PC·같은 모델인데 아래 재현(284토큰)과 입력 토큰 수가 달라 **원인 미확인**                                              |
| 2   | 도구 호출 (로컬 PC 재현, 같은 JSON)       | 비스트리밍 5/5·스트리밍 5/5·PowerShell이 만든 JSON 그대로 3/3 모두 성공. **입력 284토큰**. `tool_calls:[{"id":"call_…","function":{"index":0,"name":"get_weather","arguments":{"city":"Seoul"}}}]`, 스트리밍에서는 도구 호출이 별도 조각 1개로 오고 그다음 `done` 조각 | **`id` 제공됨**, `arguments`는 객체. 로컬 모델은 공식 설정(`RENDERER qwen3-coder`, `PARSER qwen3-coder`, `capabilities: tools`)   |
| 3   | 도구 결과 전달                            | "The current weather in Seoul is clear with a temperature of 21°C."                                                                                                                                                                                                    | 3.2절 기록 변환 동작                                                                                                              |

- 240토큰 실패는 재현되지 않았다. 도구 정의를 바꿔 보면 전체 284, `description`
  없음 272, `parameters` 없음 255, 도구 없음 15토큰으로 240이 나오는 형태를 찾지
  못했다.
- **재측정(오케스트레이터, `127.0.0.1`, 모델 내린 상태, 스트리밍): 성공.**
  9.3초에
  `tool_calls:[{"id":"call_99y0bdr2","function":{"index":0,"name":"get_weather","arguments":{"city":"Seoul"}}}]`
  조각 1개, 이어서 `done` 조각. 입력 284토큰으로 Claude 재현과 같다. 같은 요청의
  7b도 이전 145토큰 → 이번 161토큰으로 달랐다. 이전 측정 창에서 토큰 수가 적게
  나온 원인은 **미확인**(같은 PC의 다른 Ollama인 컨테이너 `0.33.3`에는 두 모델이
  없어 그쪽도 아님). 첫 측정 실패는 일회성으로 기록한다.
- **결론(2단계 방침):** 공식 설정의 `qwen3-coder:30b` + Ollama `0.35.0`은
  `tool_calls`를 정상으로 내며 `id`를 준다. 보조 파서는 넣지 않고 시작하고,
  2단계 실측에서 본문에 도구 호출 텍스트가 섞이면 다시 판단한다. 스트리밍에서
  도구 호출은 `done` 전 별도 조각으로 오므로 조각마다 `tool_calls`를
  `functionCall`로 바꾸면 된다.
- **이 PC의 `localhost:11434`에는 세 곳이 동시에 연결을 받는다.** `127.0.0.1` =
  Windows Ollama `0.35.0`(`qwen3-coder:30b` 있음), `::` = Docker `rockylinux9`
  컨테이너 게시 포트(컨테이너 Ollama 클라이언트 `0.33.3`, 모델은
  `bge-m3`·`qwen3:8b`뿐), `::1` = WSL 중계(`wslrelay`). 주소를 푸는 순서에 따라
  다른 서버로 갈 수 있다. 확인 시점에는 컨테이너 Ollama가 꺼져 있어 IPv6로 온
  연결은 응답 없이 끊겼다.
- 따라서 이 PC에서 측정·CLI 실행할 때는 **`localhost` 대신 `127.0.0.1`을
  쓴다**(`$OLLAMA`, `GEMINI_OLLAMA_BASE_URL` 모두). 컨테이너(`rockylinux9`) 검증
  때는 컨테이너 안에서 실행한다.

### 2026-09-30 1단계 구현 후 로컬 CLI 실측 (Windows, Ollama `0.35.0`, `qwen2.5-coder:7b`, 비대화형 `-p`)

| 확인                                 | 결과                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `-p "안녕하세요..."` 응답            | 정상 (모델 적재 포함 약 10초)                                                                                                   |
| 없는 포트(`localhost:11999`)         | 재시도 없이 약 5초 만에 `Ollama 서버(...)에 연결할 수 없습니다 (ECONNREFUSED)`                                                  |
| 없는 모델                            | 재시도·대체 모델 전환 없이 `모델 no-such-model:1b이(가) Ollama에 없습니다 - ollama list로 확인하세요`                           |
| `GEMINI_OLLAMA_MODEL` 없음           | `GEMINI_OLLAMA_MODEL 환경변수가 필요합니다` 안내 후 종료                                                                        |
| `GEMINI_MODEL=auto` 라우터 JSON 모드 | 처음엔 400(`unrecognized type OBJECT`) → 스키마 변환 추가 후 정상(`Score: 10`)                                                  |
| 헤더를 70초 늦게 보내는 가짜 서버    | 재시도 없이 응답 수신 - **CLI 전역 헤더 60초 제한을 전용 dispatcher가 피함 확인**                                               |
| 토큰 사용량 (`--output-format json`) | 도구 정의 없이(1단계) 입력 **6,412토큰** - 시스템 프롬프트만으로 32768의 약 20%. 도구 정의가 붙는 2단계에서 다시 측정(6절 위험) |

미해결·참고:

- 비대화형 텍스트 모드에서 API 오류 뒤에
  `An unexpected critical error occurred:[object Object]`가 한 줄 더 나온다.
  원본 동작이다(`nonInteractiveCli.ts:393`이 오류 객체를 그대로 던짐). 안내
  문구는 그 위에 정상 출력된다.
- Windows에서 **응답이 5초 이상 걸린 비대화형 실행**의 종료 시
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c`가
  나고 종료 코드가 127이 된다(응답은 정상 출력). 실제 Ollama로 1~2초 만에 끝나면
  발생하지 않는다. 같은 undici `Agent`로 단독 스크립트를 돌리면 재현되지 않았다.
  원본 경로와의 비교는 인증 검증에 막혀 하지 못했다. libuv의 Windows 전용 코드라
  대상 환경(rockylinux9)에서는 해당 여부를 따로 확인한다.

### 2026-09-30 2단계 구현 후 로컬 CLI 실측 (Windows, Ollama `0.35.0` `127.0.0.1`, `qwen3-coder:30b`, 비대화형 `-p --approval-mode yolo`)

| 확인                                                             | 결과                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 한 요청으로 "파일 읽고 설명 → 셸로 파일 목록 → 파일 수정 → 요약" | 성공. 44초, 모델 요청 5회·오류 0. 도구 `read_file` 1, `run_shell_command` 2, `replace` 1 모두 성공, 파일이 실제로 바뀜                                                                                             |
| 입력 토큰                                                        | 5회 합계 58,197(캐시 46,139) → **요청당 약 1.1만 토큰**(시스템 프롬프트 + 도구 정의). 1단계(도구 없음) 6,412에서 약 5천 늘어남. 한도 28,672의 약 40%가 시작부터 차 있다 → 3단계에서 `tools.exclude`·압축 설정 검토 |
| 응답 언어                                                        | 한국어로 요청했지만 영어로 답함(모델 경향). 필요하면 `GEMINI.md` 등에 응답 언어 지시를 둔다                                                                                                                        |
| 429 계속 반환하는 가짜 서버                                      | 10회 재시도 후 오류 종료, Gemini 모델 전환 없음. 화면 문구는 원본 그대로 `Error when talking to Gemini API ... RetryableQuotaError: Ollama 요청 실패 (429): server busy`                                           |

### 2026-09-30 보조 파서 추가 전후 (로컬 PC, `qwen3-coder:30b`, CLI 비대화형, 같은 요청 "notes.txt를 읽고 품목 이름만 나열")

| 구분         | Ollama가 본문 텍스트로 낸 도구 호출                                         | CLI 결과                                                 |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| 보조 파서 전 | 10회 중 4회 (PowerShell 1회 + Git Bash 4회 중 2회 + 로깅 프록시 5회 중 1회) | 그 4회는 XML 텍스트를 답으로 출력하고 끝남               |
| 보조 파서 후 | 10회 중 2회                                                                 | **10회 모두 정답**(`banana, milk, bread`) - 2회는 복구됨 |

- 실패한 원문(로깅 프록시로 확인):
  `content="<function=read_file>\n<parameter=file_path>\nC:\...\notes.txt\n</parameter>\n</function>\n</tool_call>"`,
  `tool_calls=[]`, 생성 토큰 78(성공은 80 - 여는 `<tool_call>\n` 2토큰이 빠짐).
- 단순 API 요청(도구 1개, 입력 284토큰)에서는 13회 중 0회였다. 도구 15개·입력 약
  1.1만 토큰인 실제 CLI 요청에서 잦아진다.
- PowerShell에서 3단계 작업(읽기 → 셸 → 수정)도 성공(17.5초, 이번에는 한국어로
  답함).

### 2026-09-30 3단계 컨텍스트·압축 실측 (로컬 PC, `qwen3-coder:30b`, `num_ctx` 32768, CLI 한도 28,672)

| 확인                                          | 결과                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기본 부하(첫 요청 입력)                       | 기본 승인 모드(도구 8개) 8,777 / yolo(도구 15개) 11,233 = 시스템 프롬프트 6,133(30,285자) + 도구 정의 4,860 + 첫 사용자 메시지 240. 도구별 상위 `replace` 991, `grep_search` 735, `run_shell_command` 558. 웹 도구 2개 제외 시 약 330 감소(15 → 13개 확인) |
| 한 요청 안 도구 반복(파일 6개 읽기, `-p` 1회) | 입력 11,465 → 29,207, **압축 없음**(사용자 턴이 하나라 자를 곳이 없음 - 원본 동작), 잘림 없음                                                                                                                                                              |
| 여러 턴(`--resume`, 임계값 0.2로 강제)        | 2턴 시작에 `utility_compressor` 호출, 입력 16,978 → 3,078. 3턴에서 파일 재열람 없이 네 파일 marker 모두 정답. 12개 요청 모두 `truncated = 0`                                                                                                               |
| 도구 출력 한도 (60,054자 셸 출력)             | 16000: 입력 +6,084(11,132 → 17,216) / 40000(원본 기본): +14,953(11,190 → 26,143, 한도의 91%)                                                                                                                                                               |

- `--resume`으로 새 프로세스를 띄우면 첫 압축 판단이 기록만의 추정치로
  시작해(시스템 프롬프트·도구 약 1.1만 빠짐) 대화형보다 늦게 압축된다. 대화형
  연속 사용은 매 응답의 실측값을 쓴다.
- 결정: `compressionThreshold` 0.7, `truncateToolOutputThreshold` 16000,
  `tools.exclude` `["google_web_search", "web_fetch"]` (5절 샘플 그대로).
  `num_ctx`는 SQL 튜닝 REST API와 같은 32768 유지.
