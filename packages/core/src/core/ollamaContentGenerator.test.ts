/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FinishReason,
  GenerateContentResponse,
  Type,
  type GenerateContentParameters,
} from '@google/genai';
import {
  OllamaApiError,
  OllamaContentGenerator,
  toJsonSchema,
  type OllamaFetch,
  type OllamaHttpResponse,
} from './ollamaContentGenerator.js';
import {
  getOllamaTokenLimit,
  loadOllamaConfig,
  type OllamaConfig,
} from './ollamaConfig.js';
import { tokenLimit } from './tokenLimits.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { isRetryableError } from '../utils/retry.js';
import { getErrorStatus } from '../utils/httpErrors.js';

const CONFIG: OllamaConfig = {
  baseUrl: 'http://ollama:11434',
  model: 'main-model',
  fastModel: 'fast-model',
  numCtx: 32768,
  timeoutMs: 600_000,
};

/** 바이트 조각 배열을 그대로 흘려보내는 응답 (조각 경계가 줄·글자 중간이어도 되는지 확인용). */
function streamResponse(
  pieces: Array<string | Uint8Array>,
): OllamaHttpResponse {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) {
          controller.enqueue(
            typeof piece === 'string' ? encoder.encode(piece) : piece,
          );
        }
        controller.close();
      },
    }),
    text: async () => pieces.join(''),
  };
}

function ndjson(...chunks: object[]): string {
  return chunks.map((c) => JSON.stringify(c) + '\n').join('');
}

function errorResponse(status: number, body: string): OllamaHttpResponse {
  return {
    ok: false,
    status,
    statusText: 'ERR',
    body: null,
    text: async () => body,
  };
}

const DONE = {
  model: 'main-model',
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 193,
  prompt_eval_cached_count: 145,
  eval_count: 16,
};

function textChunk(content: string) {
  return {
    model: 'main-model',
    message: { role: 'assistant', content },
    done: false,
  };
}

function setup(response: OllamaHttpResponse | Error) {
  const fetchFn = vi.fn<OllamaFetch>(async () => {
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  return { fetchFn, generator: new OllamaContentGenerator(CONFIG, fetchFn) };
}

const REQUEST: GenerateContentParameters = {
  model: 'gemini-2.5-pro',
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
};

async function collect(
  stream: AsyncGenerator<GenerateContentResponse>,
): Promise<GenerateContentResponse[]> {
  const out: GenerateContentResponse[] = [];
  for await (const chunk of stream) {
    out.push(chunk);
  }
  return out;
}

describe('OllamaContentGenerator', () => {
  describe('buildChatRequest', () => {
    const generator = new OllamaContentGenerator(CONFIG, vi.fn());

    it('converts system instruction, roles, thoughts and attachments', () => {
      const body = generator.buildChatRequest(
        {
          model: 'gemini-2.5-pro',
          contents: [
            { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
            {
              role: 'model',
              parts: [{ text: 'thinking...', thought: true }, { text: 'c' }],
            },
            { role: 'model', parts: [{ text: 'only thought', thought: true }] },
            {
              role: 'user',
              parts: [{ inlineData: { mimeType: 'image/png', data: 'xx' } }],
            },
          ],
          config: {
            systemInstruction: { role: 'system', parts: [{ text: 'sys' }] },
          },
        },
        LlmRole.MAIN,
      );
      expect(body.messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'a\nb' },
        { role: 'assistant', content: 'c' },
        { role: 'user', content: '[첨부 생략: image/png]' },
      ]);
      expect(body.stream).toBe(true);
    });

    it('accepts string contents and string system instruction', () => {
      const body = generator.buildChatRequest(
        { model: 'x', contents: 'hello', config: { systemInstruction: 's' } },
        LlmRole.MAIN,
      );
      expect(body.messages).toEqual([
        { role: 'system', content: 's' },
        { role: 'user', content: 'hello' },
      ]);
    });

    it('picks the model by role, ignoring the Gemini model name', () => {
      expect(generator.buildChatRequest(REQUEST, LlmRole.MAIN).model).toBe(
        'main-model',
      );
      expect(generator.buildChatRequest(REQUEST, LlmRole.SUBAGENT).model).toBe(
        'main-model',
      );
      expect(
        generator.buildChatRequest(REQUEST, LlmRole.UTILITY_COMPRESSOR).model,
      ).toBe('fast-model');
    });

    it('maps generation options and always sets num_ctx', () => {
      const body = generator.buildChatRequest(
        {
          ...REQUEST,
          config: {
            temperature: 0.2,
            topP: 0.9,
            topK: 40,
            seed: 7,
            maxOutputTokens: 100,
            stopSequences: ['END'],
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
        LlmRole.MAIN,
      );
      expect(body.options).toEqual({
        num_ctx: 32768,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        seed: 7,
        num_predict: 100,
        stop: ['END'],
      });
      expect(body.format).toBeUndefined();
      expect(body.keep_alive).toBeUndefined();
    });

    it('sets format for JSON mode', () => {
      const schema = { type: 'object', properties: { a: { type: 'string' } } };
      expect(
        generator.buildChatRequest(
          {
            ...REQUEST,
            config: {
              responseMimeType: 'application/json',
              responseJsonSchema: schema,
            },
          },
          LlmRole.UTILITY_ROUTER,
        ).format,
      ).toEqual(schema);
      expect(
        generator.buildChatRequest(
          { ...REQUEST, config: { responseMimeType: 'application/json' } },
          LlmRole.UTILITY_ROUTER,
        ).format,
      ).toBe('json');
    });

    it('converts Gemini-style schemas in JSON mode (router classifier uses Type.OBJECT)', () => {
      const format = generator.buildChatRequest(
        {
          ...REQUEST,
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema: {
              type: Type.OBJECT,
              properties: { score: { type: Type.INTEGER } },
              required: ['score'],
            },
          },
        },
        LlmRole.UTILITY_ROUTER,
      ).format;
      expect(format).toEqual({
        type: 'object',
        properties: { score: { type: 'integer' } },
        required: ['score'],
      });
    });

    it('sends keep_alive when configured', () => {
      const g = new OllamaContentGenerator(
        { ...CONFIG, keepAlive: '30m' },
        vi.fn(),
      );
      expect(g.buildChatRequest(REQUEST, LlmRole.MAIN).keep_alive).toBe('30m');
    });
  });

  describe('generateContentStream', () => {
    it('posts to /api/chat with the dedicated dispatcher and abort signal', async () => {
      const { fetchFn, generator } = setup(streamResponse([ndjson(DONE)]));
      const controller = new AbortController();
      await collect(
        await generator.generateContentStream(
          { ...REQUEST, config: { abortSignal: controller.signal } },
          'p1',
          LlmRole.MAIN,
        ),
      );
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe('http://ollama:11434/api/chat');
      expect(init.signal).toBe(controller.signal);
      expect(init.dispatcher).toBeDefined();
      expect(JSON.parse(init.body)).toMatchObject({
        model: 'main-model',
        stream: true,
      });
    });

    it('yields text chunks and a final chunk with finishReason and usage', async () => {
      const { generator } = setup(
        streamResponse([
          ndjson(textChunk('Hi'), textChunk(''), textChunk('!'), DONE),
        ]),
      );
      const chunks = await collect(
        await generator.generateContentStream(REQUEST, 'p1', LlmRole.MAIN),
      );
      expect(chunks).toHaveLength(3);
      expect(chunks.every((c) => c instanceof GenerateContentResponse)).toBe(
        true,
      );
      expect(chunks.map((c) => c.text ?? '').join('')).toBe('Hi!');
      const last = chunks[2];
      expect(last.candidates?.[0].finishReason).toBe(FinishReason.STOP);
      expect(last.candidates?.[0].content).toEqual({
        role: 'model',
        parts: [],
      });
      expect(last.usageMetadata).toEqual({
        promptTokenCount: 193,
        candidatesTokenCount: 16,
        totalTokenCount: 209,
        cachedContentTokenCount: 145,
      });
      expect(last.modelVersion).toBe('main-model');
    });

    it('handles lines and multi-byte characters split across network chunks', async () => {
      const bytes = new TextEncoder().encode(ndjson(textChunk('안녕'), DONE));
      // "안"(3바이트)의 1·2바이트 뒤에서 잘라 JSON 줄과 글자 모두 조각 경계에 걸치게 한다.
      const cut = JSON.stringify(textChunk('안녕')).indexOf('안') + 1;
      const { generator } = setup(
        streamResponse([
          bytes.slice(0, cut),
          bytes.slice(cut, cut + 1),
          bytes.slice(cut + 1),
        ]),
      );
      const chunks = await collect(
        await generator.generateContentStream(REQUEST, 'p1', LlmRole.MAIN),
      );
      expect(chunks[0].text).toBe('안녕');
      expect(chunks).toHaveLength(2);
    });

    it('parses a last line without a trailing newline', async () => {
      const { generator } = setup(
        streamResponse([
          JSON.stringify(textChunk('a')) + '\n' + JSON.stringify(DONE),
        ]),
      );
      const chunks = await collect(
        await generator.generateContentStream(REQUEST, 'p1', LlmRole.MAIN),
      );
      expect(chunks[1].candidates?.[0].finishReason).toBe(FinishReason.STOP);
    });

    it('maps thinking to thought parts', async () => {
      const { generator } = setup(
        streamResponse([
          ndjson(
            {
              message: { role: 'assistant', content: '', thinking: 'hmm' },
              done: false,
            },
            DONE,
          ),
        ]),
      );
      const chunks = await collect(
        await generator.generateContentStream(REQUEST, 'p1', LlmRole.MAIN),
      );
      expect(chunks[0].candidates?.[0].content?.parts).toEqual([
        { text: 'hmm', thought: true },
      ]);
    });

    it.each([
      ['stop', FinishReason.STOP],
      ['length', FinishReason.MAX_TOKENS],
      ['unload', FinishReason.OTHER],
      [undefined, FinishReason.OTHER],
    ])('maps done_reason %s', async (doneReason, expected) => {
      const { generator } = setup(
        streamResponse([ndjson({ ...DONE, done_reason: doneReason })]),
      );
      const [chunk] = await collect(
        await generator.generateContentStream(REQUEST, 'p1', LlmRole.MAIN),
      );
      expect(chunk.candidates?.[0].finishReason).toBe(expected);
    });

    it('throws when the stream ends without done', async () => {
      const { generator } = setup(streamResponse([ndjson(textChunk('Hi'))]));
      const stream = await generator.generateContentStream(
        REQUEST,
        'p1',
        LlmRole.MAIN,
      );
      await expect(collect(stream)).rejects.toThrow('완료 신호(done)');
    });

    it('throws on an error line in the stream', async () => {
      const { generator } = setup(
        streamResponse([ndjson(textChunk('Hi'), { error: 'boom' })]),
      );
      const stream = await generator.generateContentStream(
        REQUEST,
        'p1',
        LlmRole.MAIN,
      );
      await expect(collect(stream)).rejects.toThrow('Ollama 오류: boom');
    });

    it('throws before returning the stream when the first line is an error', async () => {
      const { generator } = setup(streamResponse([ndjson({ error: 'bad' })]));
      await expect(
        generator.generateContentStream(REQUEST, 'p1', LlmRole.MAIN),
      ).rejects.toThrow('Ollama 오류: bad');
    });
  });

  describe('errors', () => {
    it('404 model not found: no status so it does not enter the Gemini fallback flow', async () => {
      const { generator } = setup(
        errorResponse(
          404,
          '{"error":"model \\"main-model\\" not found, try pulling it first"}',
        ),
      );
      const error = await generator
        .generateContentStream(REQUEST, 'p1', LlmRole.MAIN)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('ollama list');
      expect((error as Error).message).toContain('main-model');
      expect(getErrorStatus(error)).toBeUndefined();
      expect(isRetryableError(error, true)).toBe(false);
    });

    it('404 other: still no status', async () => {
      const { generator } = setup(errorResponse(404, '404 page'));
      const error = await generator
        .generateContentStream(REQUEST, 'p1', LlmRole.MAIN)
        .catch((e: unknown) => e);
      expect((error as Error).message).toContain('404 page');
      expect(getErrorStatus(error)).toBeUndefined();
    });

    it.each([429, 500, 503])(
      '%i keeps status for the retry logic',
      async (status) => {
        const { generator } = setup(errorResponse(status, '{"error":"busy"}'));
        const error = await generator
          .generateContentStream(REQUEST, 'p1', LlmRole.MAIN)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OllamaApiError);
        expect(getErrorStatus(error)).toBe(status);
        expect((error as Error).message).toContain('busy');
        expect(isRetryableError(error, true)).toBe(true);
      },
    );

    it('reads nested {"error":{"message"}} bodies', async () => {
      const { generator } = setup(
        errorResponse(
          400,
          '{"error":{"code":400,"message":"unrecognized type OBJECT","type":"invalid_request_error"}}',
        ),
      );
      const error = await generator
        .generateContentStream(REQUEST, 'p1', LlmRole.MAIN)
        .catch((e: unknown) => e);
      expect((error as Error).message).toBe(
        'Ollama 요청 실패 (400): unrecognized type OBJECT',
      );
    });

    it('400 is not retried', async () => {
      const { generator } = setup(errorResponse(400, 'bad request'));
      const error = await generator
        .generateContentStream(REQUEST, 'p1', LlmRole.MAIN)
        .catch((e: unknown) => e);
      expect(isRetryableError(error, true)).toBe(false);
    });

    it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])(
      '%s fails immediately without retry',
      async (code) => {
        const { generator } = setup(
          new TypeError('fetch failed', { cause: { code } }),
        );
        const error = await generator
          .generateContentStream(REQUEST, 'p1', LlmRole.MAIN)
          .catch((e: unknown) => e);
        expect((error as Error).message).toContain(
          'Ollama 서버(http://ollama:11434)에 연결할 수 없습니다',
        );
        expect(isRetryableError(error, true)).toBe(false);
      },
    );

    it('other network errors are passed through and stay retryable', async () => {
      const original = new TypeError('fetch failed', {
        cause: { code: 'UND_ERR_HEADERS_TIMEOUT' },
      });
      const { generator } = setup(original);
      const error = await generator
        .generateContentStream(REQUEST, 'p1', LlmRole.MAIN)
        .catch((e: unknown) => e);
      expect(error).toBe(original);
      expect(isRetryableError(error, true)).toBe(true);
    });

    it('abort errors are passed through', async () => {
      const abort = new DOMException(
        'This operation was aborted',
        'AbortError',
      );
      const { generator } = setup(abort);
      await expect(
        generator.generateContentStream(REQUEST, 'p1', LlmRole.MAIN),
      ).rejects.toBe(abort);
    });
  });

  describe('generateContent', () => {
    it('merges the stream into one response', async () => {
      const { generator } = setup(
        streamResponse([ndjson(textChunk('{"a"'), textChunk(':1}'), DONE)]),
      );
      const response = await generator.generateContent(
        REQUEST,
        'p1',
        LlmRole.UTILITY_ROUTER,
      );
      expect(response).toBeInstanceOf(GenerateContentResponse);
      expect(response.text).toBe('{"a":1}');
      expect(response.candidates?.[0].content?.parts).toEqual([
        { text: '{"a":1}' },
      ]);
      expect(response.candidates?.[0].finishReason).toBe(FinishReason.STOP);
      expect(response.usageMetadata?.promptTokenCount).toBe(193);
    });
  });

  describe('countTokens / embedContent', () => {
    it('estimates tokens locally', async () => {
      const generator = new OllamaContentGenerator(CONFIG, vi.fn());
      const { totalTokens } = await generator.countTokens({
        model: 'x',
        contents: [
          { role: 'user', parts: [{ text: 'hello world '.repeat(30) }] },
        ],
      });
      expect(totalTokens).toBeGreaterThan(0);
    });

    it('embedContent is not supported yet', async () => {
      const generator = new OllamaContentGenerator(CONFIG, vi.fn());
      await expect(
        generator.embedContent({ model: 'x', contents: 'a' }),
      ).rejects.toThrow('embedContent');
    });
  });
});

describe('ollamaConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads defaults', () => {
    expect(
      loadOllamaConfig({
        GEMINI_OLLAMA_BASE_URL: 'http://localhost:11434/',
        GEMINI_OLLAMA_MODEL: 'qwen2.5-coder:7b',
      }),
    ).toEqual({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder:7b',
      fastModel: 'qwen2.5-coder:7b',
      numCtx: 32768,
      embedModel: undefined,
      keepAlive: undefined,
      timeoutMs: 600_000,
    });
  });

  it('reads optional values', () => {
    expect(
      loadOllamaConfig({
        GEMINI_OLLAMA_BASE_URL: 'http://gpu:11434',
        GEMINI_OLLAMA_MODEL: 'a',
        GEMINI_OLLAMA_FAST_MODEL: 'b',
        GEMINI_OLLAMA_NUM_CTX: '16384',
        GEMINI_OLLAMA_KEEP_ALIVE: '30m',
        GEMINI_OLLAMA_TIMEOUT_SECONDS: '120',
      }),
    ).toMatchObject({
      fastModel: 'b',
      numCtx: 16384,
      keepAlive: '30m',
      timeoutMs: 120_000,
    });
  });

  it.each([
    [{}, 'GEMINI_OLLAMA_BASE_URL'],
    [{ GEMINI_OLLAMA_BASE_URL: 'not a url' }, 'GEMINI_OLLAMA_BASE_URL'],
    [{ GEMINI_OLLAMA_BASE_URL: 'http://a:1' }, 'GEMINI_OLLAMA_MODEL'],
    [
      {
        GEMINI_OLLAMA_BASE_URL: 'http://a:1',
        GEMINI_OLLAMA_MODEL: 'm',
        GEMINI_OLLAMA_NUM_CTX: '32k',
      },
      'GEMINI_OLLAMA_NUM_CTX',
    ],
  ])('rejects %o', (env, name) => {
    expect(() => loadOllamaConfig(env)).toThrow(name);
  });

  it('token limit is num_ctx minus the output reserve', () => {
    expect(getOllamaTokenLimit({})).toBeUndefined();
    expect(getOllamaTokenLimit({ GEMINI_OLLAMA_BASE_URL: 'http://a:1' })).toBe(
      28_672,
    );
    expect(
      getOllamaTokenLimit({
        GEMINI_OLLAMA_BASE_URL: 'http://a:1',
        GEMINI_OLLAMA_NUM_CTX: '65536',
      }),
    ).toBe(61_440);
  });

  it('tokenLimit() uses the Ollama limit regardless of model name', () => {
    vi.stubEnv('GEMINI_OLLAMA_BASE_URL', 'http://a:1');
    vi.stubEnv('GEMINI_OLLAMA_NUM_CTX', '');
    expect(tokenLimit('gemini-2.5-pro')).toBe(28_672);
    expect(tokenLimit('qwen3-coder:30b')).toBe(28_672);
  });
});

describe('toJsonSchema', () => {
  it('lowercases types, drops propertyOrdering and converts int64 strings', () => {
    expect(
      toJsonSchema({
        type: 'OBJECT',
        propertyOrdering: ['a', 'b'],
        properties: {
          a: {
            type: 'ARRAY',
            minItems: '1',
            maxItems: '3',
            items: { type: 'STRING', maxLength: '10' },
          },
          b: { type: 'NUMBER', minimum: 0 },
        },
        required: ['a'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        a: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: { type: 'string', maxLength: 10 },
        },
        b: { type: 'number', minimum: 0 },
      },
      required: ['a'],
    });
  });

  it('turns nullable into a null type', () => {
    expect(toJsonSchema({ type: 'STRING', nullable: true })).toEqual({
      type: ['string', 'null'],
    });
    expect(
      toJsonSchema({
        anyOf: [{ type: 'STRING' }, { type: 'INTEGER' }],
        nullable: true,
      }),
    ).toEqual({
      anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }],
    });
    expect(toJsonSchema({ type: 'STRING', nullable: false })).toEqual({
      type: 'string',
    });
  });

  it('keeps property names and data values that look like keywords', () => {
    expect(
      toJsonSchema({
        type: 'object',
        properties: {
          type: { type: 'STRING', enum: ['OBJECT', 'STRING'] },
          nullable: { type: 'BOOLEAN', default: true },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['OBJECT', 'STRING'] },
        nullable: { type: 'boolean', default: true },
      },
    });
  });

  it('leaves standard JSON Schema unchanged', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: ['string', 'null'] } },
      additionalProperties: false,
    };
    expect(toJsonSchema(schema)).toEqual(schema);
  });

  it('drops TYPE_UNSPECIFIED', () => {
    expect(
      toJsonSchema({ type: 'TYPE_UNSPECIFIED', description: 'x' }),
    ).toEqual({
      description: 'x',
    });
  });
});
