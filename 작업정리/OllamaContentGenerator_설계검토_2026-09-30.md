# OllamaContentGenerator 설계 검토 (2026-09-30)

대상: `설계문서/OllamaContentGenerator_2026-09-30.md` (구현 전 설계)
방법: 설계문서의 주장·줄 번호를 v0.61.0 포크 소스와 대조

## 1. 결과 요약

- 구조(구현체 1개 + `createContentGenerator` 분기, `LlmRole` 기준 모델 선택, 항상 `stream:true`)는 코드와 맞음.
- 인용 줄 번호 대부분 정확: `config.ts:1612`, `geminiChat.ts:160`/`:1574`, `fakeContentGenerator.ts:123`, `defaultModelConfigs.ts:244`/`:252`.
- KV 3,072 MiB 계산 맞음(48층 × KV 4헤드 × 128 × f16 = 토큰당 96 KiB × 32768).
- 구현 전에 고쳐야 할 전제 3건, 명확화 5건, 사소한 오류 2건 발견 → 설계문서에 모두 반영(8절 이력).

## 2. 주요 발견

| 구분 | 내용 | 근거 | 설계문서 반영 위치 |
|---|---|---|---|
| 필수 | undici 헤더 대기가 300초가 아니라 **60초**(CLI가 전역 설정 변경). 첫 적재 + 긴 프롬프트면 스트리밍이어도 끊길 수 있음 | `core/src/utils/fetch.ts:33-34`, `:216` | 3.3절 - 전용 `dispatcher` |
| 필수 | 기존 `fetchWithTimeout`·`createSafeAgent`는 사설 IP 차단, 전역 프록시 설정 시 Ollama 요청이 프록시로 나감 | `fetch.ts:182`, `:482`, `:515` | 3.3절 |
| 필수 | 404에 `status`를 넣으면 `ModelNotFoundError` → Gemini 대체 모델 흐름(`handleFallback`) | `googleQuotaErrors.ts:242`, `retry.ts:342` | 3.5절, 6절 |
| 필수 | 압축 기준 50% × 32768 = 16,384 → 도구·시스템 프롬프트 약 1만이면 압축이 매우 잦음 | `chatCompressionService.ts:45` | 5절 샘플(`compressionThreshold` 0.7, `truncateToolOutputThreshold` 16000), 6절 |
| 명확화 | 설정 `selectedType`이 환경변수보다 우선 | `validateNonInterActiveAuth.ts:27`, `useAuth.ts` | 2절 |
| 명확화 | Ollama 최소 버전 확인 필요(`tool_name`, 도구 스트리밍, `thinking`, 스키마 `format`) | - | 2절, 7절 1단계 |
| 명확화 | tool call id는 Ollama 값 우선, 없으면 생성(선택 사항) | `turn.ts:475` | 3.3절 |
| 명확화 | Gemini `Schema` int64 필드 문자열 → 숫자, `propertyOrdering` 제거 | - | 3.2절 |
| 명확화 | thinking 모델을 `FAST_MODEL`로 쓰면 `think:false` | - | 3.1절 |
| 정정 | `UTILITY_*` 11종 → 10종 | `telemetry/llmRole.ts` | 3.1절 |
| 정정 | `getErrorStatus` 위치 `utils/retry.ts` → `utils/httpErrors.ts:16` | - | 3.5절 |

## 3. 결정 (설계문서 9절, 2026-09-30 오케스트레이터 결정)

- 연결 거부·DNS 실패: **즉시 실패** (응답 도중 끊김·타임아웃은 기존 재시도 유지)
- `tokenLimit`: **출력 여유분 4096 차감** (32768 → 28,672)

## 4. 다음 할 일

- ~~폐쇄망 GPU 서버 Ollama 버전 확인·기록~~ 완료: `0.35.0` (설계문서 2절)
- 1단계 구현 착수 (`작업정리/OllamaContentGenerator_수정단계_2026-09-30.md`)
