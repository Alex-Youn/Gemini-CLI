# OllamaContentGenerator 설계 (2026-09-30)

폐쇄망에서 Gemini CLI(v0.61.0 포크)를 GPU 서버의 Ollama(`qwen3-coder:30b`)로 동작시키기 위한 설계.
대상 기능: 대화(스트리밍), 에이전트 도구(파일 읽기·쓰기·쉘 등), 대화 압축·요약 같은 내부 유틸리티 호출.
제외: 구글 로그인, 웹 검색(`googleSearch`), URL 컨텍스트(`urlContext`), 컨텍스트 캐시, 이미지 입력.

## 1. 끼워 넣는 위치

모든 모델 호출은 `ContentGenerator` 인터페이스(`packages/core/src/core/contentGenerator.ts:39`) 하나를 거친다.
생성 지점도 `createContentGenerator()` 한 곳(`config.ts:1612`에서만 호출)이므로, **구현체 하나를 추가하고 분기만 늘린다.**
호출하는 쪽(메인 대화 `geminiChat.ts`, 압축, 요약, 토큰 계산 등 20여 곳)은 수정하지 않는다.

```
createContentGenerator(authType = 'ollama')
  └─ LoggingContentGenerator            (기존 - 로그·텔레메트리 래퍼, 그대로 사용)
       └─ OllamaContentGenerator        (신규)
            └─ fetch → Ollama /api/chat (NDJSON 스트림), /api/embed
```

`ModelMappingContentGenerator`는 쓰지 않는다. 모델 이름 바꾸기는 신규 구현체가 직접 한다(3.1절).

## 2. 설정 (환경변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `GEMINI_OLLAMA_BASE_URL` | (필수) | 예: `http://localhost:11434`. **이 값이 있으면 인증 방식을 `ollama`로 자동 선택** |
| `GEMINI_OLLAMA_MODEL` | (필수) | 예: `qwen3-coder:30b`. 모든 요청의 모델을 이 값으로 바꿈 |
| `GEMINI_OLLAMA_FAST_MODEL` | = `GEMINI_OLLAMA_MODEL` | 유틸리티 호출(압축·요약·라우터 등)용. GPU 1장이면 **비워 두는 것을 권장**(모델 2개를 번갈아 올리면 느려짐) |
| `GEMINI_OLLAMA_NUM_CTX` | 32768 | 모든 요청의 `options.num_ctx` + CLI의 컨텍스트 한도(`tokenLimit`) |
| `GEMINI_OLLAMA_EMBED_MODEL` | (없음) | 임베딩용. 없으면 `embedContent`는 미지원 오류 |
| `GEMINI_OLLAMA_KEEP_ALIVE` | (Ollama 기본) | 요청의 `keep_alive`(예: `30m`) |
| `GEMINI_OLLAMA_TIMEOUT_SECONDS` | 600 | 요청 하나의 최대 시간(첫 모델 적재 포함) |

- **접두어 `GEMINI_OLLAMA_`를 붙이는 이유**: `OLLAMA_HOST`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_CONTEXT_LENGTH` 등은 **Ollama 서버가 읽는 환경변수**다.
  CLI와 `ollama serve`가 같은 서버·같은 셸 프로파일에 있으면 이름이 겹쳐 서로 영향을 준다.
- **num_ctx는 SQL 튜닝 REST API와 같은 값(32768)으로 맞춘다.** Ollama는 같은 모델이라도 `num_ctx`가 다른 요청이 오면
  모델을 **다시 적재**한다. 두 클라이언트가 값이 다르면 번갈아 호출될 때마다 30B 모델을 다시 올리게 된다.
- `.env`(작업 폴더 또는 `~/.gemini/.env`)에도 둘 수 있다. 기존 CLI가 `.env`를 읽는 방식을 그대로 따른다.

## 3. OllamaContentGenerator (신규 `packages/core/src/core/ollamaContentGenerator.ts`)

### 3.1 모델 선택

- `req.model`(Gemini 이름)은 **무시**하고 세 번째 인자 `role: LlmRole`로 고른다.
  - `MAIN`, `SUBAGENT` → `GEMINI_OLLAMA_MODEL`
  - `UTILITY_*`(압축·요약·라우터·루프 감지 등 11종) → `GEMINI_OLLAMA_FAST_MODEL`
- 이유: 내부 유틸리티 호출은 `gemini-*-flash-lite` 같은 이름을 쓰는데, 이름 매핑표를 두면 원본 버전이 올라갈 때마다 깨진다.

### 3.2 요청 변환 (Gemini `GenerateContentParameters` → Ollama `/api/chat`)

**메시지 (`contents` + `config.systemInstruction`)**

| Gemini | Ollama | 비고 |
|---|---|---|
| `systemInstruction` (문자열·`Content`·`Part[]`) | 맨 앞 `{role:'system', content}` | 텍스트만 이어 붙임 |
| `role:'user'`의 `text` 파트 | `{role:'user', content}` | 한 Content의 텍스트 여러 개는 줄바꿈으로 연결 |
| `role:'user'`의 `functionResponse` 파트 | 파트마다 `{role:'tool', tool_name: name, content: JSON.stringify(response)}` | 같은 Content 안의 텍스트보다 **먼저** 넣음(직전 assistant의 tool_calls 바로 뒤) |
| `role:'model'`의 `text` 파트(`thought` 아님) | `{role:'assistant', content}` | |
| `role:'model'`의 `functionCall` 파트 | 같은 assistant 메시지의 `tool_calls:[{function:{name, arguments: args}}]` | `arguments`는 **객체 그대로**(OpenAI와 달리 문자열 아님) |
| `thought:true` 파트, `thoughtSignature` | 버림 | Gemini 전용 |
| `inlineData`, `fileData` | 텍스트 `[첨부 생략: <mimeType>]` | qwen3-coder는 이미지 입력 없음 |
| `contents`가 문자열·단일 Content·`Part[]` | `Content[]`로 정규화 후 위 규칙 | SDK 타입 `ContentListUnion` |

**도구 (`config.tools`, `config.toolConfig`)**

- `functionDeclarations[]` → `tools:[{type:'function', function:{name, description, parameters}}]`
  - `parametersJsonSchema`가 있으면 그대로, `parameters`(Gemini `Schema`)면 JSON Schema로 변환:
    `type` 대문자 enum(`OBJECT`, `STRING` …) → 소문자, `nullable` → `type` 배열 등 재귀 변환.
- `googleSearch`, `urlContext`, `codeExecution` 등 함수 선언이 아닌 도구 → **빼고** 디버그 로그만 남김.
- `toolConfig.functionCallingConfig.mode === 'NONE'` → `tools`를 보내지 않음. `ANY`(강제 호출)는 Ollama에 대응 옵션이 없어 무시.

**생성 옵션 (`config` → `options`)**

| Gemini | Ollama `options` |
|---|---|
| (항상) | `num_ctx` = `GEMINI_OLLAMA_NUM_CTX` |
| `temperature`, `topP`, `topK`, `seed` | `temperature`, `top_p`, `top_k`, `seed` |
| `maxOutputTokens` | `num_predict` |
| `stopSequences` | `stop` |
| `presencePenalty`, `frequencyPenalty` | `presence_penalty`, `frequency_penalty` |
| `responseMimeType:'application/json'` + `responseJsonSchema`/`responseSchema` | 최상위 `format`: 스키마 객체(없으면 `'json'`) |
| `thinkingConfig`, `candidateCount`, `cachedContent`, `labels`, `mediaResolution` | 무시 |
| `abortSignal` | `fetch`의 `signal`(타임아웃 신호와 합침) |

유틸리티 호출(`BaseLlmClient.generateJson`)이 `responseJsonSchema`로 JSON을 요구하므로 `format` 변환은 1단계부터 필요하다.

### 3.3 응답 변환 (Ollama NDJSON → `GenerateContentResponse`)

- **항상 `stream:true`로 요청한다.** `generateContent`(비스트리밍)도 내부적으로 스트림을 받아 합친다.
  이유: Node 내장 `fetch`(undici)는 응답 헤더를 기본 300초까지만 기다린다. 비스트리밍이면 생성이 끝나야 헤더가 오므로
  30B 모델의 긴 답변·첫 적재에서 끊길 수 있다.
- 줄마다 JSON 한 개. 조각별로 `GenerateContentResponse`를 만들어 yield:

| Ollama 조각 | Gemini 응답 |
|---|---|
| `message.content` (빈 문자열 아님) | `candidates[0].content = {role:'model', parts:[{text}]}` |
| `message.thinking` | `parts:[{text, thought:true}]` (생각 표시용, 기록에는 안 남음) |
| `message.tool_calls[]` | `parts:[{functionCall:{id, name, args}}]` - `id`는 `ollama-<요청순번>-<n>`으로 생성(Ollama는 id를 안 줌) |
| 마지막 `done:true` | `finishReason` + `usageMetadata` (parts는 빈 배열 - `role:'model'` + 빈 parts는 유효 응답으로 처리됨, `geminiChat.ts:160`) |

- `done_reason` → `finishReason`: `stop` → `STOP`, `length` → `MAX_TOKENS`, 그 밖 → `OTHER`.
  **마지막 조각에 `finishReason`이 없으면 `geminiChat`이 `NO_FINISH_REASON` 오류로 재시도한다(`geminiChat.ts:1574`)** - 스트림이 `done` 없이 끊기면 오류를 던진다.
- `usageMetadata`: `promptTokenCount = prompt_eval_count`, `candidatesTokenCount = eval_count`, `totalTokenCount = 합`.
  CLI는 이 값(`getLastPromptTokenCount`)으로 대화 압축 시점을 정하므로 **실측값을 반드시 채운다.**
- 응답 객체는 `Object.setPrototypeOf(obj, GenerateContentResponse.prototype)`로 만든다(`fakeContentGenerator.ts:123`과 같은 방식 - `.text`, `.functionCalls` 게터가 동작해야 함).
- `candidates[0].index = 0`, `modelVersion = 실제 Ollama 모델 이름`.

### 3.4 countTokens / embedContent

- `countTokens`: Ollama에 토큰 수 API가 없으므로 기존 추정 함수 `estimateTokenCountSync`(`utils/tokenCalculation.ts:120`, ASCII 0.33·비ASCII 1.5토큰/글자)로 계산.
  실제 값은 응답의 `prompt_eval_count`가 보정한다.
- `embedContent`: `GEMINI_OLLAMA_EMBED_MODEL`이 있으면 `POST /api/embed {model, input:[텍스트...]}` → `embeddings`. 없으면 "지원하지 않음" 오류.
  (v0.61.0 기준 `BaseLlmClient.generateEmbedding` 호출처가 없어 우선순위 낮음)

### 3.5 오류 처리

| 상황 | 처리 |
|---|---|
| 연결 거부·DNS 실패 | `Ollama 서버(<URL>)에 연결할 수 없습니다 - ollama serve 기동과 GEMINI_OLLAMA_BASE_URL을 확인하세요` |
| HTTP 404 + 모델 없음 | `모델 <이름>이 Ollama에 없습니다 - ollama list로 확인하세요` (재시도 안 함) |
| HTTP 429·5xx | 오류 객체에 `status`를 넣어 던짐 → 기존 재시도 로직(`utils/retry.ts`의 `getErrorStatus`)이 그대로 동작 |
| 스트림 중 `{"error": ...}` 줄 | 그 메시지로 오류 |
| 타임아웃·사용자 취소 | `AbortError` 그대로 전달(ESC 취소가 동작해야 함) |

## 4. 기존 파일 수정 (작은 수정)

| 파일 | 수정 |
|---|---|
| `core/src/core/contentGenerator.ts` | `AuthType.OLLAMA = 'ollama'` 추가. `getAuthTypeFromEnv()` 맨 앞에서 `GEMINI_OLLAMA_BASE_URL` 확인. `createContentGeneratorConfig()`는 OLLAMA면 **API 키 저장소(keytar) 조회 전에 바로 반환** - 원본 주석대로 Docker·SSH 리눅스에서 keytar가 멈출 수 있음. `createContentGenerator()`에 분기 추가 |
| `core/src/core/tokenLimits.ts` | `GEMINI_OLLAMA_BASE_URL`이 있으면 `GEMINI_OLLAMA_NUM_CTX`를 한도로 반환. 지금은 모르는 모델이 **1,048,576**으로 잡혀 압축(기본 한도의 50%)이 시작되기 전에 Ollama가 앞부분을 잘라냄 |
| `cli/src/config/auth.ts` | `validateAuthMethod()`에 OLLAMA: `BASE_URL`과 `MODEL`이 없으면 안내 문구 반환 |
| `cli/src/ui/auth/useAuth.ts` | `selectedType`이 비어 있고 `GEMINI_OLLAMA_BASE_URL`이 있으면 OLLAMA 사용 - 첫 실행 때 인증 선택 창이 안 뜨게 |
| `core/src/index.ts` | 필요 시 신규 클래스 export |

수정한 원본 파일 머리에는 `// (2026-09 폐쇄망 포크) ...` 한 줄로 변경 표시(Apache-2.0 조건).

## 5. 설정 파일로 끄는 것 (코드 수정 없음)

`~/.gemini/settings.json` 샘플:

```json
{
  "security": { "auth": { "selectedType": "ollama" } },
  "general": { "enableAutoUpdate": false, "enableAutoUpdateNotification": false },
  "privacy": { "usageStatisticsEnabled": false },
  "tools": { "exclude": ["google_web_search", "web_fetch"] }
}
```

- 웹 검색·웹 가져오기는 Gemini 전용 기능(`defaultModelConfigs.ts:244` `googleSearch`, `:252` `urlContext`)이라 도구 목록에서 뺀다.
- 모델은 `GEMINI_MODEL`(또는 `-m`)에 `auto`가 아닌 값을 준다. `auto`면 매 턴 라우터 분류 호출(`UTILITY_ROUTER`)이 추가로 나가 느려진다.
  화면 하단 모델 표시는 이 값이 보이므로 `GEMINI_MODEL=qwen3-coder:30b`로 맞춘다.

## 6. 위험 요소

| 위험 | 대응 |
|---|---|
| 모델이 도구 호출을 `tool_calls`가 아닌 **본문 텍스트**(`<tool_call>…` 등)로 내보냄 - Ollama 파서가 못 알아본 경우 | 2단계 실측에서 확인. 자주 나오면 본문에서 도구 호출 형식을 찾아 `functionCall`로 바꾸는 보조 파서 추가 |
| 도구 정의 + 시스템 프롬프트만으로 수천~1만 토큰 → 32768에서 여유가 적음 | 3단계에서 첫 요청의 `prompt_eval_count` 실측. 부족하면 `tools.exclude`로 안 쓰는 도구를 빼거나 num_ctx 상향(GPU 메모리 확인 - 32768에서 KV 3,072 MiB) |
| 30B 로컬 모델의 여러 단계 에이전트 작업 품질 | 파일 읽기·설명·단일 파일 수정부터 검증하고 기대 범위를 문서화 |
| 원본 버전 업그레이드 시 충돌 | 신규 파일 1개 + 작은 수정 4~5곳으로 범위를 제한. `upstream` 원격으로 비교 |

## 7. 단계별 진행과 검증

| 단계 | 범위 | 검증 (컨테이너 `rockylinux9`, Ollama `qwen3-coder:30b`) |
|---|---|---|
| 1 | 설정·인증 연결, 텍스트 대화 스트리밍, `finishReason`·`usageMetadata`, JSON 모드(`format`) | `gemini -p "안녕"` 응답, 대화형에서 스트리밍 표시, ESC 취소 |
| 2 | 도구 호출 변환(요청 `tools`, 응답 `tool_calls`, 기록의 `functionCall`/`functionResponse`) | 파일 읽기 → 설명, 쉘 명령 실행, 파일 한 개 수정까지 한 대화에서 성공 |
| 3 | `tokenLimit`, `countTokens`, 대화 압축 | 긴 대화에서 압축이 동작하고 Ollama 로그에 `truncating input prompt`가 없음 |
| 4 | 폐쇄망 패키지 | `runtime/node` + 빌드 결과 + `settings.json`·`.env` 샘플을 tar로 묶고 반입 절차서 작성 |

단위 테스트(vitest, `fetch` 모킹): 기록 변환(도구 호출 왕복 포함), 스트림 조각 → 응답, `done_reason` 매핑, JSON 모드, 오류 상태 코드.

참고: Qwen Code(`QwenLM/qwen-code`, Gemini CLI 포크, Apache-2.0)의 `OpenAIContentGenerator`가 같은 문제(OpenAI 형식)를 푼 구현이라 변환 경계 사례를 비교할 때 참고한다.
