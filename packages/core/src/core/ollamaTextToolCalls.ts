/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// (2026-09 폐쇄망 포크) 본문 텍스트로 나온 qwen3-coder 도구 호출 복구 - 설계문서 6절 보조 파서
//
// qwen3-coder:30b가 가끔 여는 태그 `<tool_call>`만 빠뜨리고 나머지를 그대로 낸다(2026-09-30 실측, CLI 요청 10회 중 4회):
//   <function=read_file>\n<parameter=file_path>\nC:\a.txt\n</parameter>\n</function>\n</tool_call>
// 그러면 Ollama 파서가 인식하지 못해 `tool_calls` 대신 `content`로 온다. 이 형식만 찾아 도구 호출로 바꾼다.

const MARKERS = ['<tool_call>', '<function='];
const FUNCTION_RE = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g;
const PARAMETER_RE = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;

export interface TextToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** 도구 이름 → 매개변수 이름 → JSON Schema (값 타입 변환용). */
export type ToolParameterSchemas = Map<string, Record<string, unknown>>;

/** 값 앞뒤의 줄바꿈 한 개씩은 형식상 들어간 것이라 뺀다. */
function stripWrappingNewlines(value: string): string {
  return value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

function schemaTypes(schema: unknown): string[] {
  if (typeof schema !== 'object' || schema === null || !('type' in schema)) {
    return [];
  }
  const type: unknown = schema.type;
  if (typeof type === 'string') {
    return [type];
  }
  return Array.isArray(type)
    ? type.filter((t): t is string => typeof t === 'string')
    : [];
}

/** XML 안의 값은 모두 문자열이므로 도구 스키마의 타입에 맞춰 바꾼다. 맞출 수 없으면 문자열 그대로. */
function coerceValue(raw: string, schema: unknown): unknown {
  for (const type of schemaTypes(schema)) {
    switch (type) {
      case 'integer':
      case 'number': {
        const n = Number(raw.trim());
        if (raw.trim() !== '' && Number.isFinite(n)) {
          return n;
        }
        break;
      }
      case 'boolean':
        if (raw.trim() === 'true' || raw.trim() === 'false') {
          return raw.trim() === 'true';
        }
        break;
      case 'null':
        if (raw.trim() === 'null') {
          return null;
        }
        break;
      case 'array':
      case 'object':
        try {
          const parsed: unknown = JSON.parse(raw);
          if (
            type === 'array'
              ? Array.isArray(parsed)
              : typeof parsed === 'object'
          ) {
            return parsed;
          }
        } catch {
          // 아래에서 문자열로 둔다.
        }
        break;
      case 'string':
        return raw;
      default:
        break;
    }
  }
  return raw;
}

/**
 * 본문에서 도구 호출을 찾는다. `toolNames`에 있는 도구만 인정한다
 * (모델이 형식을 설명하느라 쓴 예시 텍스트를 실행하지 않도록).
 * 하나도 못 찾으면 calls가 비고 text는 원문 그대로.
 */
export function parseTextToolCalls(
  text: string,
  parameterSchemas: ToolParameterSchemas,
): { calls: TextToolCall[]; text: string } {
  const calls: TextToolCall[] = [];
  const rest = text.replace(
    FUNCTION_RE,
    (match, name: string, body: string) => {
      const schemas = parameterSchemas.get(name);
      if (!schemas) {
        return match;
      }
      const args: Record<string, unknown> = {};
      for (const [, key, value] of body.matchAll(PARAMETER_RE)) {
        args[key] = coerceValue(stripWrappingNewlines(value), schemas[key]);
      }
      calls.push({ name, args });
      return '';
    },
  );
  if (calls.length === 0) {
    return { calls, text };
  }
  return {
    calls,
    text: rest.replace(/<\/?tool_call>/g, '').trim(),
  };
}

/** 요청의 tools에서 도구별 매개변수 스키마를 모은다. */
export function collectParameterSchemas(
  tools: Array<{ function: { name: string; parameters: unknown } }> | undefined,
): ToolParameterSchemas {
  const result: ToolParameterSchemas = new Map();
  for (const tool of tools ?? []) {
    const parameters = tool.function.parameters;
    const properties =
      typeof parameters === 'object' &&
      parameters !== null &&
      'properties' in parameters &&
      typeof parameters.properties === 'object' &&
      parameters.properties !== null
        ? Object.fromEntries(Object.entries(parameters.properties))
        : {};
    result.set(tool.function.name, properties);
  }
  return result;
}

/**
 * 스트리밍 중 본문을 받아, 도구 호출 형식이 시작되면(또는 시작될 수 있는 조각이 끝에 걸리면)
 * 그 뒤를 화면에 내보내지 않고 모아 둔다. 끝에서 `finish()`로 도구 호출과 남은 텍스트를 받는다.
 */
export class TextToolCallExtractor {
  private held = '';
  private holding = false;

  constructor(private readonly parameterSchemas: ToolParameterSchemas) {}

  /** 지금 내보내도 되는 텍스트를 돌려준다. */
  push(text: string): string {
    if (this.holding) {
      this.held += text;
      return '';
    }
    const combined = this.held + text;
    this.held = '';
    const start = Math.min(
      ...MARKERS.map((m) => combined.indexOf(m)).filter((i) => i !== -1),
    );
    if (Number.isFinite(start)) {
      this.holding = true;
      this.held = combined.slice(start);
      return combined.slice(0, start);
    }
    // 끝부분이 표식의 앞부분("<fun" 등)이면 다음 조각까지 기다린다.
    const partial = this.partialMarkerLength(combined);
    this.held = combined.slice(combined.length - partial);
    return combined.slice(0, combined.length - partial);
  }

  finish(): { calls: TextToolCall[]; text: string } {
    const held = this.held;
    this.held = '';
    this.holding = false;
    if (!held) {
      return { calls: [], text: '' };
    }
    return parseTextToolCalls(held, this.parameterSchemas);
  }

  private partialMarkerLength(text: string): number {
    for (let len = Math.min(text.length, 10); len > 0; len--) {
      const tail = text.slice(-len);
      if (MARKERS.some((m) => m.startsWith(tail))) {
        return len;
      }
    }
    return 0;
  }
}
