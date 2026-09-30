/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// (2026-09 폐쇄망 포크) Ollama 연동 설정 - 설계문서/OllamaContentGenerator_2026-09-30.md 2절

export const OLLAMA_ENV = {
  BASE_URL: 'GEMINI_OLLAMA_BASE_URL',
  MODEL: 'GEMINI_OLLAMA_MODEL',
  FAST_MODEL: 'GEMINI_OLLAMA_FAST_MODEL',
  NUM_CTX: 'GEMINI_OLLAMA_NUM_CTX',
  EMBED_MODEL: 'GEMINI_OLLAMA_EMBED_MODEL',
  KEEP_ALIVE: 'GEMINI_OLLAMA_KEEP_ALIVE',
  TIMEOUT_SECONDS: 'GEMINI_OLLAMA_TIMEOUT_SECONDS',
} as const;

export const DEFAULT_OLLAMA_NUM_CTX = 32768;
export const DEFAULT_OLLAMA_TIMEOUT_SECONDS = 600;
/** num_ctx는 출력 토큰까지 포함하므로 CLI 한도에서 답변 자리를 뺀다(9절 결정 2). */
export const OLLAMA_OUTPUT_RESERVE_TOKENS = 4096;

type Env = Record<string, string | undefined>;

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  fastModel: string;
  numCtx: number;
  embedModel?: string;
  keepAlive?: string;
  timeoutMs: number;
}

function readEnv(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readPositiveInt(env: Env, name: string, defaultValue: number): number {
  const raw = readEnv(env, name);
  if (raw === undefined) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 값이 올바르지 않습니다: "${raw}" (양의 정수)`);
  }
  return value;
}

export function isOllamaConfigured(env: Env = process.env): boolean {
  return readEnv(env, OLLAMA_ENV.BASE_URL) !== undefined;
}

/** 필수 값이 없거나 형식이 틀리면 안내 문구를 담은 오류를 던진다. */
export function loadOllamaConfig(env: Env = process.env): OllamaConfig {
  const baseUrl = readEnv(env, OLLAMA_ENV.BASE_URL);
  if (!baseUrl) {
    throw new Error(
      `${OLLAMA_ENV.BASE_URL} 환경변수가 필요합니다 (예: http://localhost:11434)`,
    );
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(
      `${OLLAMA_ENV.BASE_URL} 값이 올바른 URL이 아닙니다: ${baseUrl}`,
    );
  }
  const model = readEnv(env, OLLAMA_ENV.MODEL);
  if (!model) {
    throw new Error(
      `${OLLAMA_ENV.MODEL} 환경변수가 필요합니다 (예: qwen3-coder:30b)`,
    );
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    fastModel: readEnv(env, OLLAMA_ENV.FAST_MODEL) ?? model,
    numCtx: readPositiveInt(env, OLLAMA_ENV.NUM_CTX, DEFAULT_OLLAMA_NUM_CTX),
    embedModel: readEnv(env, OLLAMA_ENV.EMBED_MODEL),
    keepAlive: readEnv(env, OLLAMA_ENV.KEEP_ALIVE),
    timeoutMs:
      readPositiveInt(
        env,
        OLLAMA_ENV.TIMEOUT_SECONDS,
        DEFAULT_OLLAMA_TIMEOUT_SECONDS,
      ) * 1000,
  };
}

/**
 * Ollama를 쓰면 CLI 컨텍스트 한도(압축 판단 기준)를 num_ctx - 출력 여유분으로 둔다.
 * 모델 이름이 아니라 환경변수로 판단한다. 설정되지 않았으면 undefined.
 */
export function getOllamaTokenLimit(
  env: Env = process.env,
): number | undefined {
  if (!isOllamaConfigured(env)) {
    return undefined;
  }
  let numCtx: number;
  try {
    numCtx = readPositiveInt(env, OLLAMA_ENV.NUM_CTX, DEFAULT_OLLAMA_NUM_CTX);
  } catch {
    // 잘못된 값은 생성기 초기화(loadOllamaConfig)에서 안내한다.
    numCtx = DEFAULT_OLLAMA_NUM_CTX;
  }
  return Math.max(
    numCtx - OLLAMA_OUTPUT_RESERVE_TOKENS,
    Math.floor(numCtx / 2),
  );
}
