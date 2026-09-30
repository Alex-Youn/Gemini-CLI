/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// (2026-09 폐쇄망 포크) Ollama /api/chat 연동 - 설계문서/OllamaContentGenerator_2026-09-30.md 3절

import {
  FinishReason,
  GenerateContentResponse,
  type Candidate,
  type Content,
  type ContentListUnion,
  type ContentUnion,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from '@google/genai';
import * as undici from 'undici';
import type { ContentGenerator } from './contentGenerator.js';
import type { OllamaConfig } from './ollamaConfig.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { estimateTokenCountSync } from '../utils/tokenCalculation.js';
import { debugLogger } from '../utils/debugLogger.js';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: true;
  options: Record<string, unknown>;
  format?: unknown;
  keep_alive?: string;
}

interface OllamaChatChunk {
  model?: string;
  message?: { role?: string; content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
  error?: string;
}

export interface OllamaHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type OllamaFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    dispatcher: undici.Dispatcher;
  },
) => Promise<OllamaHttpResponse>;

/** 429·5xx 등 - `status`가 있어 기존 재시도 로직(`utils/retry.ts`)이 그대로 동작한다. */
export class OllamaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OllamaApiError';
  }
}

/** 재시도해도 소용없는 연결 실패 - 재시도 판단에 걸리지 않게 `code`·`cause`를 두지 않는다(9절 결정 1). */
const CONNECTION_FAILURE_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];

function findErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function isContent(c: unknown): c is Content {
  return typeof c === 'object' && c !== null && ('parts' in c || 'role' in c);
}

function toContents(contents: ContentListUnion): Content[] {
  const toPart = (p: string | Part): Part =>
    typeof p === 'string' ? { text: p } : p;

  if (!Array.isArray(contents)) {
    if (isContent(contents)) {
      return [contents];
    }
    return [{ role: 'user', parts: [toPart(contents)] }];
  }
  if (contents.every(isContent)) {
    return contents;
  }
  const parts = (contents as Array<string | Part>).map(toPart);
  return [{ role: 'user', parts }];
}

function partToText(part: Part): string | undefined {
  if (part.thought) {
    return undefined;
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  const mimeType = part.inlineData?.mimeType ?? part.fileData?.mimeType;
  if (part.inlineData || part.fileData) {
    return `[첨부 생략: ${mimeType ?? 'unknown'}]`;
  }
  // functionCall·functionResponse 변환은 2단계(도구 호출)에서 추가한다.
  return undefined;
}

function systemInstructionToText(
  instruction: ContentUnion | undefined,
): string {
  if (instruction === undefined) {
    return '';
  }
  if (typeof instruction === 'string') {
    return instruction;
  }
  const items = Array.isArray(instruction) ? instruction : [instruction];
  return items
    .flatMap((item) =>
      typeof item === 'string'
        ? [item]
        : isContent(item)
          ? (item.parts ?? []).map(partToText)
          : [partToText(item)],
    )
    .filter((t): t is string => !!t)
    .join('\n');
}

export function toOllamaMessages(
  contents: ContentListUnion,
  systemInstruction?: ContentUnion,
): OllamaMessage[] {
  const messages: OllamaMessage[] = [];
  const system = systemInstructionToText(systemInstruction);
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  for (const content of toContents(contents)) {
    const text = (content.parts ?? [])
      .map(partToText)
      .filter((t): t is string => !!t)
      .join('\n');
    if (!text) {
      continue;
    }
    messages.push({
      role: content.role === 'model' ? 'assistant' : 'user',
      content: text,
    });
  }
  return messages;
}

function toOllamaOptions(
  config: GenerateContentConfig | undefined,
  numCtx: number,
): Record<string, unknown> {
  const options: Record<string, unknown> = { num_ctx: numCtx };
  const set = (key: string, value: unknown) => {
    if (value !== undefined) {
      options[key] = value;
    }
  };
  set('temperature', config?.temperature);
  set('top_p', config?.topP);
  set('top_k', config?.topK);
  set('seed', config?.seed);
  set('num_predict', config?.maxOutputTokens);
  set('stop', config?.stopSequences);
  set('presence_penalty', config?.presencePenalty);
  set('frequency_penalty', config?.frequencyPenalty);
  return options;
}

/** Gemini `Schema`의 int64 필드는 문자열로 온다. */
const INT64_SCHEMA_KEYS = new Set([
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
]);
/** 값이 "이름 → 스키마" 맵인 키 (맵의 키 이름을 스키마 키워드로 오해하지 않게). */
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
]);
/** 값이 스키마가 아닌 데이터인 키 - 그대로 둔다. */
const SCHEMA_DATA_KEYS = new Set([
  'enum',
  'const',
  'default',
  'example',
  'examples',
  'required',
]);

/**
 * Gemini `Schema` 표기(대문자 `type`, `nullable`, 문자열 int64, `propertyOrdering`)를
 * Ollama가 받는 JSON Schema로 바꾼다. 이미 JSON Schema면 그대로 나온다.
 * CLI 내부 호출도 `responseJsonSchema`에 `Type.OBJECT` 같은 대문자를 넣으므로 모든 스키마에 적용한다.
 */
export function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(toJsonSchema);
  }
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'propertyOrdering' || key === 'nullable') {
      continue;
    }
    if (key === 'type') {
      const types = (Array.isArray(value) ? value : [value])
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.toLowerCase())
        .filter((t) => t !== 'type_unspecified');
      if (types.length > 0) {
        result['type'] = types.length === 1 ? types[0] : types;
      }
    } else if (INT64_SCHEMA_KEYS.has(key) && typeof value === 'string') {
      result[key] = Number(value);
    } else if (SCHEMA_MAP_KEYS.has(key) && typeof value === 'object' && value) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, s]) => [name, toJsonSchema(s)]),
      );
    } else if (SCHEMA_DATA_KEYS.has(key)) {
      result[key] = value;
    } else {
      result[key] = toJsonSchema(value);
    }
  }
  if ('nullable' in schema && schema.nullable === true) {
    const type: unknown = result['type'];
    const anyOf: unknown = result['anyOf'];
    if (typeof type === 'string') {
      result['type'] = [type, 'null'];
    } else if (Array.isArray(type)) {
      result['type'] = type.includes('null') ? type : type.concat('null');
    } else if (Array.isArray(anyOf)) {
      result['anyOf'] = anyOf.concat({ type: 'null' });
    }
  }
  return result;
}

function toOllamaFormat(config: GenerateContentConfig | undefined): unknown {
  if (config?.responseMimeType !== 'application/json') {
    return undefined;
  }
  const schema = config.responseJsonSchema ?? config.responseSchema;
  return schema === undefined ? 'json' : toJsonSchema(schema);
}

function toFinishReason(doneReason: string | undefined): FinishReason {
  switch (doneReason) {
    case 'stop':
      return FinishReason.STOP;
    case 'length':
      return FinishReason.MAX_TOKENS;
    default:
      return FinishReason.OTHER;
  }
}

function toUsageMetadata(
  chunk: OllamaChatChunk,
): GenerateContentResponseUsageMetadata {
  const prompt = chunk.prompt_eval_count ?? 0;
  const candidates = chunk.eval_count ?? 0;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    totalTokenCount: prompt + candidates,
    ...(chunk.prompt_eval_cached_count !== undefined && {
      cachedContentTokenCount: chunk.prompt_eval_cached_count,
    }),
  };
}

function makeResponse(
  candidate: Candidate,
  modelVersion: string,
  usageMetadata?: GenerateContentResponseUsageMetadata,
): GenerateContentResponse {
  const response: unknown = {
    candidates: [candidate],
    modelVersion,
    ...(usageMetadata && { usageMetadata }),
  };
  Object.setPrototypeOf(response, GenerateContentResponse.prototype);
  if (response instanceof GenerateContentResponse) {
    return response;
  }
  throw new Error('Failed to create GenerateContentResponse');
}

/** 조각 하나를 응답으로 바꾼다. 보여 줄 내용도 끝 신호도 없으면 undefined. */
export function toGenerateContentResponse(
  chunk: OllamaChatChunk,
  model: string,
): GenerateContentResponse | undefined {
  const parts: Part[] = [];
  if (chunk.message?.thinking) {
    parts.push({ text: chunk.message.thinking, thought: true });
  }
  if (chunk.message?.content) {
    parts.push({ text: chunk.message.content });
  }
  if (!chunk.done && parts.length === 0) {
    return undefined;
  }
  const candidate: Candidate = { index: 0, content: { role: 'model', parts } };
  if (!chunk.done) {
    return makeResponse(candidate, chunk.model ?? model);
  }
  candidate.finishReason = toFinishReason(chunk.done_reason);
  return makeResponse(candidate, chunk.model ?? model, toUsageMetadata(chunk));
}

async function readErrorMessage(response: OllamaHttpResponse): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error = parsed.error;
      if (typeof error === 'string') {
        return error;
      }
      // {"error":{"message":...}} 형식도 온다(JSON 스키마 오류 등).
      if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        return error.message;
      }
    }
  } catch {
    // JSON이 아니면 본문 그대로 쓴다.
  }
  return text || response.statusText;
}

async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OllamaChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (line: string): OllamaChatChunk => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return JSON.parse(line) as OllamaChatChunk;
    } catch {
      throw new Error(
        `Ollama 응답 줄을 해석할 수 없습니다: ${line.slice(0, 200)}`,
      );
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          yield parse(line);
        }
      }
      if (done) {
        break;
      }
    }
    const rest = buffer.trim();
    if (rest) {
      yield parse(rest);
    }
  } finally {
    // 소비자가 중간에 멈추면(취소·오류) 연결을 닫는다.
    await reader.cancel().catch(() => {});
  }
}

const defaultFetch: OllamaFetch = (url, init) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  undici.fetch(url, init) as unknown as Promise<OllamaHttpResponse>;

export class OllamaContentGenerator implements ContentGenerator {
  /**
   * 전용 dispatcher: CLI 전역 설정(헤더 60초)과 사설 IP 차단·프록시를 피하고,
   * 헤더 대기(= 첫 조각까지, 0.35.0 실측)와 조각 사이 공백을 같은 값으로 제한한다.
   */
  private readonly dispatcher: undici.Dispatcher;

  constructor(
    private readonly config: OllamaConfig,
    private readonly fetchFn: OllamaFetch = defaultFetch,
  ) {
    this.dispatcher = new undici.Agent({
      headersTimeout: config.timeoutMs,
      bodyTimeout: config.timeoutMs,
    });
  }

  private selectModel(role: LlmRole): string {
    return role === LlmRole.MAIN || role === LlmRole.SUBAGENT
      ? this.config.model
      : this.config.fastModel;
  }

  buildChatRequest(
    request: GenerateContentParameters,
    role: LlmRole,
  ): OllamaChatRequest {
    const body: OllamaChatRequest = {
      model: this.selectModel(role),
      messages: toOllamaMessages(
        request.contents,
        request.config?.systemInstruction,
      ),
      stream: true,
      options: toOllamaOptions(request.config, this.config.numCtx),
    };
    const format = toOllamaFormat(request.config);
    if (format !== undefined) {
      body.format = format;
    }
    if (this.config.keepAlive) {
      body.keep_alive = this.config.keepAlive;
    }
    return body;
  }

  private async post(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    model: string,
  ): Promise<OllamaHttpResponse> {
    let response: OllamaHttpResponse;
    try {
      response = await this.fetchFn(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        dispatcher: this.dispatcher,
      });
    } catch (error) {
      const code = findErrorCode(error);
      if (code && CONNECTION_FAILURE_CODES.includes(code)) {
        throw new Error(
          `Ollama 서버(${this.config.baseUrl})에 연결할 수 없습니다 (${code}) - ` +
            `ollama serve 기동과 GEMINI_OLLAMA_BASE_URL을 확인하세요`,
        );
      }
      throw error;
    }
    if (response.ok) {
      return response;
    }
    const message = await readErrorMessage(response);
    if (response.status === 404) {
      // status 404를 달면 Gemini 대체 모델 전환 흐름(ModelNotFoundError)으로 넘어가므로 달지 않는다.
      throw new Error(
        /not found/i.test(message)
          ? `모델 ${model}이(가) Ollama에 없습니다 - ollama list로 확인하세요 (${message})`
          : `Ollama 요청 실패 (404 ${path}): ${message}`,
      );
    }
    throw new OllamaApiError(
      `Ollama 요청 실패 (${response.status}): ${message}`,
      response.status,
    );
  }

  private async *streamChat(
    body: OllamaChatRequest,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<GenerateContentResponse> {
    const response = await this.post('/api/chat', body, signal, body.model);
    if (!response.body) {
      throw new Error('Ollama 응답 본문이 비어 있습니다');
    }
    for await (const chunk of readNdjson(response.body)) {
      if (chunk.error) {
        throw new Error(`Ollama 오류: ${chunk.error}`);
      }
      const converted = toGenerateContentResponse(chunk, body.model);
      if (converted) {
        yield converted;
      }
      if (chunk.done) {
        return;
      }
    }
    // finishReason 없이 끝나면 geminiChat이 NO_FINISH_REASON으로 판단하므로 여기서 명확히 알린다.
    throw new Error('Ollama 응답이 완료 신호(done) 없이 끊겼습니다');
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const body = this.buildChatRequest(request, role);
    debugLogger.debug(
      `[Ollama] ${role} → ${body.model}, 메시지 ${body.messages.length}개`,
    );
    const stream = this.streamChat(body, request.config?.abortSignal);
    // 연결·HTTP 오류는 호출 시점에 던져야 재시도 로직이 스트림 시작 전 오류로 처리한다.
    const first = await stream.next();
    async function* withFirst(): AsyncGenerator<GenerateContentResponse> {
      if (first.done) {
        return;
      }
      yield first.value;
      yield* stream;
    }
    return withFirst();
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const stream = await this.generateContentStream(
      request,
      userPromptId,
      role,
    );
    const parts: Part[] = [];
    let last: GenerateContentResponse | undefined;
    for await (const chunk of stream) {
      last = chunk;
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        const prev = parts[parts.length - 1];
        if (
          prev &&
          typeof prev.text === 'string' &&
          typeof part.text === 'string' &&
          !!prev.thought === !!part.thought
        ) {
          prev.text += part.text;
        } else {
          parts.push({ ...part });
        }
      }
    }
    const lastCandidate = last?.candidates?.[0];
    return makeResponse(
      {
        index: 0,
        content: { role: 'model', parts },
        finishReason: lastCandidate?.finishReason,
      },
      last?.modelVersion ?? this.selectModel(role),
      last?.usageMetadata,
    );
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // Ollama에는 토큰 수 API가 없다. 실제 값은 응답의 prompt_eval_count가 보정한다.
    const parts = toContents(request.contents).flatMap((c) => c.parts ?? []);
    return { totalTokens: estimateTokenCountSync(parts) };
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error(
      'Ollama 연동에서는 임베딩(embedContent)을 아직 지원하지 않습니다',
    );
  }
}
