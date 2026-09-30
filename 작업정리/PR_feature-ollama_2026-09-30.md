# PR 설명: feature/ollama → master (2026-09-30)

**PR 제목(제안):** Ollama(qwen3-coder:30b) 연동 추가: 인증·스트리밍·도구
호출·압축 설정·폐쇄망 반입 패키지

---

## 1. 개요

폐쇄망에서 Gemini CLI(v0.61.0 포크)를 GPU 서버의 Ollama(`qwen3-coder:30b`)로
동작시키기 위한 변경입니다. 모든 모델 호출이 `ContentGenerator` 인터페이스
하나를 거치므로, 신규 구현체 `OllamaContentGenerator`를 추가하고
`createContentGenerator()`에 분기만 늘렸습니다. 호출하는 쪽(대화, 압축, 요약
등)은 수정하지 않았습니다. 커밋 8개, 23개 파일(+3,492/-200, 설계·작업정리 문서
포함)입니다.

```
createContentGenerator(authType = 'ollama')
  └─ LoggingContentGenerator (기존)
       └─ OllamaContentGenerator (신규) → fetch → Ollama /api/chat (NDJSON 스트림)
```

## 2. 단계별 변경

| 단계                    | 커밋                            | 내용                                                                                                                                                                                                                                      | 주요 파일                                                                                                                                                                                  |
| ----------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. 인증·텍스트 스트리밍 | `fc01c10`                       | `AuthType.OLLAMA` 추가, 텍스트 대화 스트리밍, `finishReason`·`usageMetadata` 변환, JSON 모드(`format`), 전용 undici `Agent`(CLI 전역 헤더 60초 제한 회피), 오류 처리(연결 거부는 재시도 없이 즉시 안내, 404는 Gemini 대체 모델 흐름 회피) | `ollamaContentGenerator.ts`, `ollamaConfig.ts`(신규), `contentGenerator.ts`, `tokenLimits.ts`, `cli/src/config/auth.ts`, `cli/src/ui/auth/useAuth.ts`, `utils/errorParsing.ts`, `index.ts` |
| 2. 도구 호출            | `5ed1996`                       | 요청 `tools` 변환(Gemini `Schema` → JSON Schema), 기록의 `functionCall`/`functionResponse` 왕복 변환, 본문 텍스트 도구 호출 보조 파서                                                                                                     | `ollamaContentGenerator.ts`, `ollamaTextToolCalls.ts`(신규) 및 각 테스트                                                                                                                   |
| 3. 컨텍스트·압축        | `44fde5c`                       | **코드 수정 없음.** 실측으로 설정값 확정(`compressionThreshold` 0.7, `truncateToolOutputThreshold` 16000, `tools.exclude` 웹 도구 2개)                                                                                                    | 설계문서 5·10절                                                                                                                                                                            |
| 4. 폐쇄망 패키지        | `588278f`, `32999da`, `86e2f67` | Node 런타임 포함 tar.gz 생성·설치·검증 스크립트, 한국어 응답 지시(`GEMINI.md`) 샘플 추가, 패키지 이름의 `-dirty` 판정에서 추적 안 된 파일 제외                                                                                            | `scripts/ollama-offline/`, `.gitignore`                                                                                                                                                    |
| 문서                    | `07e3876`, `71ccd6f`            | 반입본 검증 기록                                                                                                                                                                                                                          | `설계문서/`, `작업정리/`                                                                                                                                                                   |

`tokenLimits.ts`는 `GEMINI_OLLAMA_BASE_URL`이 있으면
`GEMINI_OLLAMA_NUM_CTX - 4096`(기본 28,672)을 한도로 반환합니다. 원본은 모르는
모델을 1,048,576으로 잡아 압축이 시작되기 전에 Ollama가 앞부분을 잘라냅니다.

## 3. 설정 방법

환경변수(접두어 `GEMINI_OLLAMA_`. `OLLAMA_*`는 Ollama 서버가 읽는 변수라 겹치지
않도록 구분했습니다).

| 변수                            | 기본값      | 설명                                                                                    |
| ------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `GEMINI_OLLAMA_BASE_URL`        | (필수)      | 예: `http://127.0.0.1:11434`. `selectedType`이 비어 있으면 이 값으로 `ollama` 자동 선택 |
| `GEMINI_OLLAMA_MODEL`           | (필수)      | 예: `qwen3-coder:30b`                                                                   |
| `GEMINI_OLLAMA_FAST_MODEL`      | = MODEL     | 압축·요약 등 유틸리티 호출용 (GPU 1장이면 비워 두기 권장)                               |
| `GEMINI_OLLAMA_NUM_CTX`         | 32768       | 모든 요청의 `num_ctx`. SQL 튜닝 REST API와 같은 값                                      |
| `GEMINI_OLLAMA_EMBED_MODEL`     | 없음        | 없으면 `embedContent`는 미지원 오류                                                     |
| `GEMINI_OLLAMA_KEEP_ALIVE`      | Ollama 기본 | 예: `30m`                                                                               |
| `GEMINI_OLLAMA_TIMEOUT_SECONDS` | 600         | 첫 조각까지 대기 및 조각 사이 최대 공백 (전체 응답 시간 상한 아님)                      |

`GEMINI_MODEL`은 `auto`가 아닌 값(예: `qwen3-coder:30b`)으로 지정합니다.
`auto`면 매 턴 라우터 호출이 추가됩니다.

`~/.gemini/settings.json` 샘플 (설계문서 5절, 패키지의
`config/settings.json.sample`과 동일):

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

설정 파일의 `selectedType`이 환경변수보다 우선하므로, 예전 인증 방식이 저장돼
있으면 위처럼 `"ollama"`를 명시해야 합니다.

`~/.gemini/GEMINI.md`에는 한국어 응답 지시를 둡니다(패키지
`config/GEMINI.md.sample`). 지시가 없으면 영어로 답하는 경우가
있었습니다(컨테이너 시험: 지시 없음 3회 중 1회 영어 위주, 지시 후 3회 모두
한국어).

## 4. 검증 결과

| 구분                                                                | 결과                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 단위 테스트                                                         | `ollamaContentGenerator.test.ts`, `ollamaTextToolCalls.test.ts` 추가(vitest, `fetch` 모킹). **75건 모두 통과**(보조 파서 테스트 포함 최종, 2026-09-30 재실행 확인). 실행: `npx vitest run --root packages/core src/core/ollamaContentGenerator.test.ts src/core/ollamaTextToolCalls.test.ts` |
| 전체 테스트 비교 (1단계 시점, Windows)                              | core 37건·cli 16건 실패는 **원본 코드에서도 같은 파일·같은 건수로 실패**(심볼릭 링크·샌드박스·Windows 셸·확장 관리 등, 이번 수정과 무관)                                                                                                                                                     |
| 로컬 CLI 실측 (Windows, Ollama 0.35.0, `qwen3-coder:30b`, 비대화형) | 읽기 → 셸 → 파일 수정 → 요약 한 요청: 44초, 모델 요청 5회, 오류 0, 파일 실제 변경. 요청당 입력 약 1.1만 토큰                                                                                                                                                                                 |
| 보조 파서 효과                                                      | 같은 요청 10회: 파서 전 4회가 XML 텍스트를 답으로 출력하고 끝남 → 파서 후 **10회 모두 정답**(본문 텍스트 도구 호출 2회 복구)                                                                                                                                                                 |
| 압축                                                                | `--resume` 3턴(임계값 0.2로 강제): 2턴 시작에 `utility_compressor` 호출, 입력 16,978 → 3,078, 3턴에서 내용 유지 확인, 잘림 0회                                                                                                                                                               |
| 도구 출력 한도                                                      | 60,054자 셸 출력: 16000이면 입력 +6,084, 원본 기본 40000이면 +14,953(한도의 91%)                                                                                                                                                                                                             |
| 429 반복                                                            | 10회 재시도 후 오류 종료, Gemini 모델 전환 없음                                                                                                                                                                                                                                              |
| 폐쇄망 Docker 검증                                                  | `verify-docker.sh`, 인터넷 차단(`--internal`) Rocky 9.3 컨테이너, 시스템 Node 없이 설치·실행. **9/9 통과**(인터넷 차단 확인, 중계 접속, install.sh, 텍스트 대화, 도구 호출, `grep_search`, 번들 ripgrep, 연결 실패 즉시 안내 등)                                                             |

**반입본 패키지:** `gemini-cli-ollama-0.61.0-86e2f67-linux-x64.tar.gz`
(71,690,074바이트)

SHA256: `1408a8d8cdb6fe0afbacb6c0319a0cb737dfce4828e26b0fd31dad8b95701ca0`

## 5. 설계와 달라진 점 / 알려진 제약

| 항목                       | 내용                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 도구 결과 전달             | `functionResponse`의 `{output}`·`{error}`가 하나뿐이면 JSON으로 감싸지 않고 **문자열 그대로** 전달(JSON으로 감싸면 줄바꿈·따옴표 이스케이프로 토큰이 늘고 모델이 읽기 어려움)                                                                                                          |
| 보조 파서 추가             | 설계 초안에는 없었음. 30B가 실제 CLI 요청(도구 15개, 입력 약 1.1만 토큰)에서 여는 `<tool_call>`만 빠뜨려 Ollama 파서가 놓치는 경우가 10회 중 4회 발생. 단순 API 요청(도구 1개)은 13회 중 0회. 도구를 보낸 요청에서만, 요청에 있는 도구 이름만 인정하며 해석 실패 시 원문 텍스트로 출력 |
| `ollamaConfig.ts` 신규     | 계획에 없던 파일. `tokenLimits.ts`가 생성기를 import하면 순환 참조가 생겨 환경변수 읽기를 분리                                                                                                                                                                                         |
| 압축 시점                  | 압축은 **사용자 턴 사이에서만** 일어남(원본 동작). 한 요청 안의 도구 반복은 압축되지 않으며, 넘침은 원본의 도구 출력 마스킹·`ContextWindowWillOverflow`가 막음                                                                                                                         |
| `--resume` 직후            | 첫 압축 판단이 기록만의 추정치라 시스템 프롬프트·도구(약 1.1만)가 빠져 대화형보다 늦게 압축됨                                                                                                                                                                                          |
| Windows 종료 오류 (미해결) | 응답이 5초 이상 걸린 비대화형 실행 종료 시 libuv `Assertion failed ... src/win/async.c`, 종료 코드 127 (응답은 정상 출력). Windows 전용 코드로 보이며 대상 환경(Rocky)에서는 별도 확인 필요                                                                                            |
| 비대화형 오류 출력         | API 오류 뒤 `An unexpected critical error occurred:[object Object]` 한 줄이 추가로 나옴. 원본 동작(`nonInteractiveCli.ts:393`)                                                                                                                                                         |
| 429 화면 문구              | 원본 문구 그대로 `Error when talking to Gemini API ...`로 표시                                                                                                                                                                                                                         |
| Ollama Host 검사           | 127.0.0.1에만 바인딩된 Ollama는 다른 Host 이름 요청에 403 반환. CLI를 다른 서버에서 쓰면 `OLLAMA_HOST=0.0.0.0` 필요                                                                                                                                                                    |
| 개발 PC                    | `localhost:11434`에 서로 다른 서버 3곳이 응답할 수 있어 `localhost` 대신 `127.0.0.1` 사용                                                                                                                                                                                              |
| 원본 수정 표시             | 수정한 원본 파일 머리에 `// (2026-09 폐쇄망 포크) ...` 주석(Apache-2.0 조건)                                                                                                                                                                                                           |

## 6. 리뷰어 확인 필요 / 남은 작업

- [ ] 대화형 확인: 스트리밍 표시, ESC 취소, `/compress`, 인증 선택 창이 뜨지
      않음 (`selectedType` 비었을 때)
- [ ] 대화형 긴 대화의 압축 빈도 기록
- [ ] 실제 폐쇄망 GPU 서버에서
      절차서(`작업정리/폐쇄망_반입설치절차_2026-09-30.md`) 6절 재실행
      (지금까지는 Docker 내부망 흉내 검증)
- [ ] 서버 모델에 `RENDERER qwen3-coder`, `PARSER qwen3-coder` 두 줄이 있는지
      확인 (`ollama show qwen3-coder:30b --modelfile`). GGUF를 `ollama create`로
      만든 경우 Modelfile에 직접 추가
- [ ] 30B 첫 적재 시간이 60초를 넘는 상황 실측(로컬에서는 9.4초·15.3초, 가짜
      서버 70초 지연은 통과)
- [ ] 폐쇄망 서버(`rockylinux9`/GPU 서버)에서 2단계 검증 재실행
- 선택 항목(필요할 때만): `PrivacyNotice.tsx`(현재 구글 약관 화면이 기본 표시),
  `metrics.ts`의 `getGenAiProvider()` OLLAMA 분기, `AuthDialog.tsx`에 Ollama
  항목 추가

참고 문서: `설계문서/OllamaContentGenerator_2026-09-30.md`,
`작업정리/OllamaContentGenerator_수정단계_2026-09-30.md`,
`작업정리/폐쇄망_반입설치절차_2026-09-30.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
