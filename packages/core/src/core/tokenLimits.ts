/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// (2026-09 폐쇄망 포크) Ollama 사용 시 GEMINI_OLLAMA_NUM_CTX 기준 한도

import {
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL,
  GEMMA_4_31B_IT_MODEL,
  GEMMA_4_26B_A4B_IT_MODEL,
} from '../config/models.js';
import { getOllamaTokenLimit } from './ollamaConfig.js';

type Model = string;
type TokenCount = number;

export const DEFAULT_TOKEN_LIMIT = 1_048_576;
export const GEMMA_4_TOKEN_LIMIT = 256_000;

export function tokenLimit(model: Model): TokenCount {
  // Ollama: 모델 이름과 관계없이 num_ctx 기준(대체 모델 전환으로 이름이 바뀌어도 유지)
  const ollamaLimit = getOllamaTokenLimit();
  if (ollamaLimit !== undefined) {
    return ollamaLimit;
  }
  // Add other models as they become relevant or if specified by config
  // Pulled from https://ai.google.dev/gemini-api/docs/models
  switch (model) {
    case GEMMA_4_31B_IT_MODEL:
    case GEMMA_4_26B_A4B_IT_MODEL:
      return GEMMA_4_TOKEN_LIMIT;
    case PREVIEW_GEMINI_MODEL:
    case PREVIEW_GEMINI_FLASH_MODEL:
    case DEFAULT_GEMINI_MODEL:
    case DEFAULT_GEMINI_FLASH_MODEL:
    case DEFAULT_GEMINI_FLASH_LITE_MODEL:
      return 1_048_576;
    default:
      return DEFAULT_TOKEN_LIMIT;
  }
}
