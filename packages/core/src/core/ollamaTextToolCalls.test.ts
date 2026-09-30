/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  TextToolCallExtractor,
  collectParameterSchemas,
  parseTextToolCalls,
} from './ollamaTextToolCalls.js';

const SCHEMAS = collectParameterSchemas([
  {
    function: {
      name: 'read_file',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          start_line: { type: 'integer' },
          end_line: { type: ['integer', 'null'] },
        },
      },
    },
  },
  {
    function: {
      name: 'run_shell_command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          is_background: { type: 'boolean' },
          env: { type: 'object' },
          args: { type: 'array' },
        },
      },
    },
  },
]);

// 2026-09-30 CLI 실측에서 그대로 받은 본문 (여는 <tool_call> 없음)
const REAL_FAILURE =
  '<function=read_file>\n<parameter=file_path>\nC:\\Temp\\ws2\\notes.txt\n</parameter>\n</function>\n</tool_call>';

describe('parseTextToolCalls', () => {
  it('recovers the real failure output (missing opening <tool_call>)', () => {
    expect(parseTextToolCalls(REAL_FAILURE, SCHEMAS)).toEqual({
      calls: [
        { name: 'read_file', args: { file_path: 'C:\\Temp\\ws2\\notes.txt' } },
      ],
      text: '',
    });
  });

  it('also handles the complete form, multiple calls and surrounding text', () => {
    const text =
      'Reading both.\n<tool_call>\n<function=read_file>\n<parameter=file_path>\na.txt\n</parameter>\n</function>\n</tool_call>\n' +
      '<tool_call>\n<function=run_shell_command>\n<parameter=command>\nls -la\n</parameter>\n</function>\n</tool_call>';
    expect(parseTextToolCalls(text, SCHEMAS)).toEqual({
      calls: [
        { name: 'read_file', args: { file_path: 'a.txt' } },
        { name: 'run_shell_command', args: { command: 'ls -la' } },
      ],
      text: 'Reading both.',
    });
  });

  it('coerces values by the tool schema', () => {
    const text =
      '<function=read_file><parameter=file_path>\na.txt\n</parameter><parameter=start_line>\n10\n</parameter><parameter=end_line>\nnull\n</parameter></function>' +
      '<function=run_shell_command><parameter=command>\necho 1\n</parameter><parameter=is_background>\nfalse\n</parameter>' +
      '<parameter=env>\n{"A":"1"}\n</parameter><parameter=args>\n["x", 2]\n</parameter></function>';
    expect(parseTextToolCalls(text, SCHEMAS).calls).toEqual([
      {
        name: 'read_file',
        args: { file_path: 'a.txt', start_line: 10, end_line: null },
      },
      {
        name: 'run_shell_command',
        args: {
          command: 'echo 1',
          is_background: false,
          env: { A: '1' },
          args: ['x', 2],
        },
      },
    ]);
  });

  it('keeps values that do not match the schema type as strings', () => {
    const text =
      '<function=read_file><parameter=start_line>\nten\n</parameter><parameter=unknown>\nx\n</parameter></function>';
    expect(parseTextToolCalls(text, SCHEMAS).calls[0].args).toEqual({
      start_line: 'ten',
      unknown: 'x',
    });
  });

  it('keeps multi-line values, dropping only the wrapping newlines', () => {
    const text =
      '<function=run_shell_command><parameter=command>\nline1\nline2\n\n</parameter></function>';
    expect(parseTextToolCalls(text, SCHEMAS).calls[0].args).toEqual({
      command: 'line1\nline2\n',
    });
  });

  it('ignores unknown tools and incomplete calls (text stays as is)', () => {
    const unknown =
      '<function=rm_rf><parameter=path>\n/\n</parameter></function>';
    expect(parseTextToolCalls(unknown, SCHEMAS)).toEqual({
      calls: [],
      text: unknown,
    });
    const truncated = '<function=read_file>\n<parameter=file_path>\na.txt';
    expect(parseTextToolCalls(truncated, SCHEMAS)).toEqual({
      calls: [],
      text: truncated,
    });
  });
});

describe('TextToolCallExtractor', () => {
  function run(pieces: string[]) {
    const extractor = new TextToolCallExtractor(SCHEMAS);
    const emitted = pieces.map((p) => extractor.push(p)).join('');
    return { emitted, ...extractor.finish() };
  }

  it('passes normal text through immediately', () => {
    const extractor = new TextToolCallExtractor(SCHEMAS);
    expect(extractor.push('Hello ')).toBe('Hello ');
    expect(extractor.push('world')).toBe('world');
    expect(extractor.finish()).toEqual({ calls: [], text: '' });
  });

  it('holds everything from the marker on, even split across chunks', () => {
    // 실제 스트림처럼 토큰 단위로 쪼갠다.
    const pieces = [
      'Let me read it.\n',
      '<',
      'function',
      '=read',
      '_file>\n',
      '<parameter=file_path>\n',
      'notes.txt\n',
      '</parameter>\n</function>\n',
      '</tool_call>',
    ];
    expect(run(pieces)).toEqual({
      emitted: 'Let me read it.\n',
      calls: [{ name: 'read_file', args: { file_path: 'notes.txt' } }],
      text: '',
    });
  });

  it('holds a trailing partial marker only until it is disproved', () => {
    const extractor = new TextToolCallExtractor(SCHEMAS);
    expect(extractor.push('a <')).toBe('a ');
    expect(extractor.push(' b')).toBe('< b');
    expect(extractor.push('x <tool')).toBe('x ');
    expect(extractor.finish()).toEqual({ calls: [], text: '<tool' });
  });

  it('returns held text unchanged when nothing can be parsed', () => {
    expect(run(['Use ', '<function=name> in the template.'])).toEqual({
      emitted: 'Use ',
      calls: [],
      text: '<function=name> in the template.',
    });
  });

  it('handles the real failure output token by token', () => {
    const pieces = REAL_FAILURE.match(/.{1,3}/gs) ?? [];
    expect(run(pieces)).toEqual({
      emitted: '',
      calls: [
        { name: 'read_file', args: { file_path: 'C:\\Temp\\ws2\\notes.txt' } },
      ],
      text: '',
    });
  });
});
