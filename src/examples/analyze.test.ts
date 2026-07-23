import { describe, it, expect } from 'vitest';
import {
  computeAnalysisVersion,
  parseAnalysis,
  resolveEndpointConfig,
  EndpointNotConfiguredError,
} from './analyze.js';
import type { Snippet } from './model.js';

const snippet: Snippet = {
  repo: 'o/r',
  modName: 'r',
  loader: 'forge',
  license: 'MIT',
  filePath: 'X.java',
  fileUrl: 'https://github.com/o/r/blob/sha/X.java#L1-L2',
  startLine: 1,
  endLine: 2,
  code: 'class X {}',
  language: 'java',
  imports: [],
};

describe('computeAnalysisVersion', () => {
  it('is stable and changes when any part changes', () => {
    const A = computeAnalysisVersion({ promptVersion: 'v1', model: 'm1', pipelineRev: 'r1' });
    expect(computeAnalysisVersion({ promptVersion: 'v1', model: 'm1', pipelineRev: 'r1' })).toBe(A);
    expect(
      computeAnalysisVersion({ promptVersion: 'v2', model: 'm1', pipelineRev: 'r1' })
    ).not.toBe(A);
    expect(
      computeAnalysisVersion({ promptVersion: 'v1', model: 'm2', pipelineRev: 'r1' })
    ).not.toBe(A);
    expect(
      computeAnalysisVersion({ promptVersion: 'v1', model: 'm1', pipelineRev: 'r2' })
    ).not.toBe(A);
  });
});

describe('resolveEndpointConfig', () => {
  it('throws when base URL or model is missing (a configured endpoint is required)', () => {
    expect(() => resolveEndpointConfig([], {})).toThrow(EndpointNotConfiguredError);
    expect(() => resolveEndpointConfig([], { CLEANROOM_MCP_LLM_BASE_URL: 'http://x' })).toThrow(
      EndpointNotConfiguredError
    );
  });

  it('reads env vars and normalizes the base URL', () => {
    const cfg = resolveEndpointConfig([], {
      CLEANROOM_MCP_LLM_BASE_URL: 'http://localhost:1234/v1/',
      CLEANROOM_MCP_LLM_MODEL: 'local-model',
    });
    expect(cfg.baseUrl).toBe('http://localhost:1234/v1');
    expect(cfg.model).toBe('local-model');
    expect(cfg.apiKey).toBeNull();
  });

  it('prefers CLI flags over env vars', () => {
    const cfg = resolveEndpointConfig(
      ['--llm-base-url', 'http://flag', '--llm-model', 'flag-model'],
      {
        CLEANROOM_MCP_LLM_BASE_URL: 'http://env',
        CLEANROOM_MCP_LLM_MODEL: 'env-model',
      }
    );
    expect(cfg.baseUrl).toBe('http://flag');
    expect(cfg.model).toBe('flag-model');
  });
});

describe('parseAnalysis', () => {
  it('parses a plain JSON object', () => {
    const a = parseAnalysis(
      JSON.stringify({
        title: 'T',
        caption: 'C',
        category: 'blocks',
        complexity: 'beginner',
        quality_score: 0.9,
        keywords: ['k'],
      }),
      snippet
    );
    expect(a.title).toBe('T');
    expect(a.category).toBe('blocks');
    expect(a.complexity).toBe('beginner');
    expect(a.qualityScore).toBe(0.9);
    expect(a.keywords).toEqual(['k']);
  });

  it('throws (so the orchestrator skips) on non-object completions', () => {
    // bare prose / refusal (no braces)
    expect(() => parseAnalysis('I cannot analyze this snippet.', snippet)).toThrow();
    // empty completion
    expect(() => parseAnalysis('', snippet)).toThrow();
    // NDJSON-style two objects -> jsonrepair yields an array, not an analysis
    expect(() => parseAnalysis('{"title":"A"}\n{"title":"B"}', snippet)).toThrow();
  });

  it('extracts JSON from a prose preamble and tolerates an inner code fence', () => {
    const raw =
      'Sure! Here is the analysis:\n' +
      JSON.stringify({
        title: 'T',
        category: 'blocks',
        complexity: 'beginner',
        quality_score: 0.8,
        explanation: 'Here is code:\n```java\nfoo();\n```\ndone',
        keywords: ['k'],
      }) +
      '\nHope that helps!';
    const a = parseAnalysis(raw, snippet);
    expect(a.title).toBe('T');
    expect(a.category).toBe('blocks');
    expect(a.keywords).toEqual(['k']);
    expect(a.explanation).toContain('foo()');
  });

  it('strips markdown fences, clamps quality, and normalizes bad enums', () => {
    const a = parseAnalysis(
      '```json\n' +
        JSON.stringify({ category: 'not-a-category', complexity: 'wizard', quality_score: 5 }) +
        '\n```',
      snippet
    );
    expect(a.category).toBeNull();
    expect(a.complexity).toBe('intermediate');
    expect(a.qualityScore).toBe(1);
    expect(a.title).toBe(snippet.filePath); // falls back to file path
  });
});
