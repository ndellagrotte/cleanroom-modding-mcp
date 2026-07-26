import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  analyzeSnippet,
  computeAnalysisVersion,
  createOpenAiClient,
  estimateTokens,
  isTransientLlmError,
  normalizeCategory,
  normalizeTagSlug,
  parseAnalysis,
  renderPromptTemplate,
  resolveEndpointConfig,
  CATEGORY_LIST_PLACEHOLDER,
  EndpointNotConfiguredError,
  LlmHttpError,
} from './analyze.js';
import type { LlmClient, Snippet } from './model.js';

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

  it('changes when request knobs change (thinking toggle, temperature)', () => {
    const base = {
      promptVersion: 'v1',
      model: 'm1',
      pipelineRev: 'r1',
      requestKnobs: { temperature: null, extraBody: null },
    };
    const A = computeAnalysisVersion(base);
    expect(computeAnalysisVersion({ ...base })).toBe(A);
    // Toggling a provider thinking mode invalidates exactly like a model change.
    expect(
      computeAnalysisVersion({
        ...base,
        requestKnobs: { temperature: null, extraBody: { thinking: { type: 'disabled' } } },
      })
    ).not.toBe(A);
    // …as does a temperature change (0 vs omitted).
    expect(
      computeAnalysisVersion({ ...base, requestKnobs: { temperature: 0, extraBody: null } })
    ).not.toBe(A);
  });

  it('canonicalizes knob key order (insertion order never moves the version)', () => {
    const A = computeAnalysisVersion({
      promptVersion: 'v1',
      model: 'm1',
      pipelineRev: 'r1',
      requestKnobs: { temperature: 0, extraBody: { thinking: { keep: null, type: 'disabled' } } },
    });
    const B = computeAnalysisVersion({
      promptVersion: 'v1',
      model: 'm1',
      pipelineRev: 'r1',
      requestKnobs: { extraBody: { thinking: { type: 'disabled', keep: null } }, temperature: 0 },
    });
    expect(B).toBe(A);
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

  it('uses the committed config file as the lowest precedence layer', () => {
    // File alone satisfies the gate.
    const fromFile = resolveEndpointConfig(
      [],
      {},
      {
        baseUrl: 'http://file',
        model: 'file-model',
      }
    );
    expect(fromFile.baseUrl).toBe('http://file');
    expect(fromFile.model).toBe('file-model');

    // Env beats file.
    const fromEnv = resolveEndpointConfig(
      [],
      { CLEANROOM_MCP_LLM_BASE_URL: 'http://env', CLEANROOM_MCP_LLM_MODEL: 'env-model' },
      { baseUrl: 'http://file', model: 'file-model' }
    );
    expect(fromEnv.baseUrl).toBe('http://env');
    expect(fromEnv.model).toBe('env-model');

    // Flags beat both.
    const fromFlag = resolveEndpointConfig(
      ['--llm-model', 'flag-model'],
      {},
      { baseUrl: 'http://file', model: 'file-model' }
    );
    expect(fromFlag.baseUrl).toBe('http://file');
    expect(fromFlag.model).toBe('flag-model');

    // An absent/empty file layer behaves exactly as before.
    expect(() => resolveEndpointConfig([], {}, {})).toThrow(EndpointNotConfiguredError);
  });

  it('resolves temperature flag → env → file, defaulting to the frozen 0', () => {
    // Unset everywhere → 0 (the frozen determinism default, materialized here).
    expect(
      resolveEndpointConfig([], {
        CLEANROOM_MCP_LLM_BASE_URL: 'http://x',
        CLEANROOM_MCP_LLM_MODEL: 'm',
      }).temperature
    ).toBe(0);

    // File layer.
    const fromFile = resolveEndpointConfig(
      [],
      { CLEANROOM_MCP_LLM_BASE_URL: 'http://x' },
      { model: 'm', temperature: 1 }
    );
    expect(fromFile.temperature).toBe(1);

    // Explicit file null → null (the client omits the field entirely).
    const omit = resolveEndpointConfig(
      [],
      { CLEANROOM_MCP_LLM_BASE_URL: 'http://x' },
      { model: 'm', temperature: null }
    );
    expect(omit.temperature).toBeNull();

    // Env beats file; flag beats both.
    expect(
      resolveEndpointConfig(
        [],
        {
          CLEANROOM_MCP_LLM_BASE_URL: 'http://x',
          CLEANROOM_MCP_LLM_MODEL: 'm',
          CLEANROOM_MCP_LLM_TEMPERATURE: '0.6',
        },
        { temperature: 1 }
      ).temperature
    ).toBe(0.6);
    expect(
      resolveEndpointConfig(
        ['--llm-temperature', '0.2'],
        {
          CLEANROOM_MCP_LLM_BASE_URL: 'http://x',
          CLEANROOM_MCP_LLM_MODEL: 'm',
          CLEANROOM_MCP_LLM_TEMPERATURE: '0.6',
        },
        { temperature: 1 }
      ).temperature
    ).toBe(0.2);

    // Garbage values fall through to the next layer instead of reaching the wire.
    expect(
      resolveEndpointConfig(
        ['--llm-temperature', 'hot'],
        { CLEANROOM_MCP_LLM_BASE_URL: 'http://x', CLEANROOM_MCP_LLM_MODEL: 'm' },
        { temperature: 1 }
      ).temperature
    ).toBe(1);
  });

  it('passes extraBody through from the config file only', () => {
    const extraBody = { thinking: { type: 'disabled' } };
    const cfg = resolveEndpointConfig(
      [],
      { CLEANROOM_MCP_LLM_BASE_URL: 'http://x' },
      { model: 'm', extraBody }
    );
    expect(cfg.extraBody).toEqual(extraBody);

    // Absent from the file → undefined (nothing merged into the request body).
    expect(
      resolveEndpointConfig([], { CLEANROOM_MCP_LLM_BASE_URL: 'http://x' }, { model: 'm' })
        .extraBody
    ).toBeUndefined();
  });
});

describe('isTransientLlmError (Revision 1 §4.6 — no double-pay)', () => {
  it('classifies 429 and 5xx as transient, other 4xx as permanent', () => {
    expect(isTransientLlmError(new LlmHttpError(429, 'rate limited'))).toBe(true);
    expect(isTransientLlmError(new LlmHttpError(500, 'boom'))).toBe(true);
    expect(isTransientLlmError(new LlmHttpError(503, 'unavailable'))).toBe(true);
    expect(isTransientLlmError(new LlmHttpError(400, 'bad request'))).toBe(false);
    expect(isTransientLlmError(new LlmHttpError(401, 'unauthorized'))).toBe(false);
    expect(isTransientLlmError(new LlmHttpError(404, 'not found'))).toBe(false);
  });

  it('classifies fetch network failures (TypeError) as transient', () => {
    expect(isTransientLlmError(new TypeError('fetch failed'))).toBe(true);
  });

  it('classifies JSON extraction failures as permanent (skip immediately)', () => {
    expect(isTransientLlmError(new Error('LLM completion contained no JSON object'))).toBe(false);
    expect(isTransientLlmError(new Error('LLM completion did not parse to a JSON object'))).toBe(
      false
    );
  });
});

describe('estimateTokens', () => {
  it('is chars/4 rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('analyzeSnippet (Revision 1 §4.2 — outcome carries usage)', () => {
  it('returns { analysis, usage } from the client completion', async () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    const client: LlmClient = {
      model: 'm',
      complete: () =>
        Promise.resolve({
          text: JSON.stringify({ title: 'T', quality_score: 0.7 }),
          usage,
        }),
    };
    const outcome = await analyzeSnippet(snippet, client, 'PROMPT');
    expect(outcome.analysis.title).toBe('T');
    expect(outcome.analysis.qualityScore).toBe(0.7);
    expect(outcome.usage).toEqual(usage);
  });

  it('tolerates a null usage block (local endpoints)', async () => {
    const client: LlmClient = {
      model: 'm',
      complete: () => Promise.resolve({ text: JSON.stringify({ title: 'T' }), usage: null }),
    };
    const outcome = await analyzeSnippet(snippet, client, 'PROMPT');
    expect(outcome.analysis.title).toBe('T');
    expect(outcome.usage).toBeNull();
  });
});

describe('createOpenAiClient (Revision 1 §4.2/§4.6)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Minimal structural stand-in for the fetch Response the client consumes
  // (avoids depending on DOM lib globals in this eslint environment).
  interface FakeResponse {
    ok: boolean;
    status: number;
    headers: { get: (k: string) => string | null };
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }

  function makeRes(
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): FakeResponse {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }

  const CFG = { baseUrl: 'http://llm.test', apiKey: null, model: 'test-model', temperature: null };
  const OK_BODY = {
    choices: [{ message: { content: '{"title":"T"}' } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };

  it('returns text + parsed usage from a successful completion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(200, OK_BODY));
    vi.stubGlobal('fetch', fetchMock);
    const client = createOpenAiClient(CFG);
    const completion = await client.complete('p');
    expect(completion.text).toBe('{"title":"T"}');
    expect(completion.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the configured temperature, omits it on null, and honors per-call override', async () => {
    const bodyOf = (call: unknown[]): Record<string, unknown> =>
      JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;

    const fetchMock = vi.fn().mockResolvedValue(makeRes(200, OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    // The materialized frozen default (what resolveEndpointConfig returns when
    // temperature is unset everywhere) goes on the wire as 0.
    await createOpenAiClient({ ...CFG, temperature: 0 }).complete('p');
    expect(bodyOf(fetchMock.mock.calls[0]).temperature).toBe(0);

    // CFG null (explicit "temperature": null in the file) → field omitted.
    await createOpenAiClient(CFG).complete('p');
    expect('temperature' in bodyOf(fetchMock.mock.calls[1])).toBe(false);

    // Configured endpoint temperature wins (endpoints that reject 0).
    await createOpenAiClient({ ...CFG, temperature: 1 }).complete('p');
    expect(bodyOf(fetchMock.mock.calls[2]).temperature).toBe(1);

    // A per-call override still beats the configured value.
    await createOpenAiClient({ ...CFG, temperature: 1 }).complete('p', { temperature: 0.3 });
    expect(bodyOf(fetchMock.mock.calls[3]).temperature).toBe(0.3);
  });

  it('merges extraBody into the request with code-controlled keys winning', async () => {
    const bodyOf = (call: unknown[]): Record<string, unknown> =>
      JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;

    const fetchMock = vi.fn().mockResolvedValue(makeRes(200, OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    // Provider extensions (e.g. Moonshot's thinking toggle) go on the wire verbatim.
    await createOpenAiClient({
      ...CFG,
      extraBody: { thinking: { type: 'disabled' } },
    }).complete('p');
    expect(bodyOf(fetchMock.mock.calls[0]).thinking).toEqual({ type: 'disabled' });

    // A hostile/buggy config cannot clobber the pinned model or messages.
    await createOpenAiClient({
      ...CFG,
      temperature: 0,
      extraBody: { model: 'other-model', messages: [], temperature: 9 },
    }).complete('p');
    const body = bodyOf(fetchMock.mock.calls[1]);
    expect(body.model).toBe('test-model');
    expect(Array.isArray(body.messages) && body.messages.length).toBe(2);
    expect(body.temperature).toBe(0);
  });

  it('warns once when the server echoes a different model id', async () => {
    const mismatchedBody = { ...OK_BODY, model: 'served-other-model' };
    const fetchMock = vi.fn().mockResolvedValue(makeRes(200, mismatchedBody));
    vi.stubGlobal('fetch', fetchMock);

    const onModelMismatch = vi.fn();
    const client = createOpenAiClient(CFG, { onModelMismatch });
    await client.complete('p');
    await client.complete('p');
    expect(onModelMismatch).toHaveBeenCalledTimes(1);
    expect(onModelMismatch).toHaveBeenCalledWith('served-other-model', 'test-model');
  });

  it('stays silent when the server echoes the requested model (or none)', async () => {
    const onModelMismatch = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeRes(200, { ...OK_BODY, model: 'test-model' }))
      .mockResolvedValueOnce(makeRes(200, OK_BODY)); // no model field at all
    vi.stubGlobal('fetch', fetchMock);

    const client = createOpenAiClient(CFG, { onModelMismatch });
    await client.complete('p');
    await client.complete('p');
    expect(onModelMismatch).not.toHaveBeenCalled();
  });

  it('returns null usage when the endpoint omits the usage block', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(makeRes(200, { choices: [{ message: { content: '{"title":"T"}' } }] }))
    );
    const client = createOpenAiClient(CFG);
    expect((await client.complete('p')).usage).toBeNull();
  });

  it('throws a non-transient LlmHttpError on 400 without retrying (no double-pay)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(400, 'bad request'));
    vi.stubGlobal('fetch', fetchMock);
    const client = createOpenAiClient(CFG);
    const err = await client.complete('p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).status).toBe(400);
    expect(isTransientLlmError(err)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast (transient) when Retry-After exceeds the cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeRes(429, 'slow down', { 'retry-after': '120' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createOpenAiClient(CFG);
    const err = await client.complete('p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(isTransientLlmError(err)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no waiting out a daily window
  });

  it('honors --llm-max-retries for 429 backoff, then throws transient', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(429, 'slow down', { 'retry-after': '0' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createOpenAiClient(CFG, { maxRetries: 1 });
    const err = await client.complete('p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).status).toBe(429);
    expect(isTransientLlmError(err)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  }, 15000);

  it('recovers when a 429 is followed by a 200 (existing backoff semantics)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeRes(429, 'slow down', { 'retry-after': '0' }))
      .mockResolvedValueOnce(makeRes(200, OK_BODY));
    vi.stubGlobal('fetch', fetchMock);
    const client = createOpenAiClient(CFG);
    const completion = await client.complete('p');
    expect(completion.usage?.totalTokens).toBe(18);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 15000);
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

describe('normalizeCategory', () => {
  it('accepts an exact slug unchanged', () => {
    expect(normalizeCategory('tile-entities')).toEqual({ slug: 'tile-entities', rejected: null });
  });

  it('absorbs the formatting the model actually emits', () => {
    // The prompt renders slugs in backticks, so models echo them back that way.
    for (const raw of ['Blocks', ' blocks ', '`blocks`', '"blocks"', 'BLOCKS']) {
      expect(normalizeCategory(raw).slug).toBe('blocks');
    }
    expect(normalizeCategory('tile entities').slug).toBe('tile-entities');
    expect(normalizeCategory('tile_entities').slug).toBe('tile-entities');
    expect(normalizeCategory('coremods/mixins').slug).toBe('coremods-mixins');
  });

  it('maps near-miss labels onto the closest slug', () => {
    expect(normalizeCategory('mixin').slug).toBe('coremods-mixins');
    expect(normalizeCategory('proxy').slug).toBe('cross-platform');
    expect(normalizeCategory('capability').slug).toBe('capabilities');
    expect(normalizeCategory('inventory').slug).toBe('storage-systems');
    expect(normalizeCategory('widgets').slug).toBe('gui');
    expect(normalizeCategory('api').slug).toBe('api-design');
  });

  it('distinguishes a decline from a failed label', () => {
    // A decline: nothing to report, the model was allowed to say null.
    for (const raw of [null, undefined, '', '   ', 'null', 'none']) {
      expect(normalizeCategory(raw)).toEqual({ slug: null, rejected: null });
    }
    // A failed label: reported, so a taxonomy mismatch is visible in the build.
    expect(normalizeCategory('quantum-widgets')).toEqual({
      slug: null,
      rejected: 'quantum-widgets',
    });
  });

  it('reports the raw string, not the slugified one, so the tally is actionable', () => {
    expect(normalizeCategory('Data Generation').rejected).toBe('Data Generation');
  });
});

describe('normalizeTagSlug', () => {
  it('converges the three spellings that split the v1 tags table', () => {
    const slugs = ['forge-1.12.2', 'forge-1-12-2', 'forge 1.12.2'].map(normalizeTagSlug);
    expect(new Set(slugs).size).toBe(1);
    expect(slugs[0]).toBe('forge-1-12-2');
  });

  it('lowercases, collapses separators, and strips edge hyphens', () => {
    expect(normalizeTagSlug('  Tile__Entity / NBT  ')).toBe('tile-entity-nbt');
    expect(normalizeTagSlug('C++')).toBe('c++');
  });
});

describe('parseAnalysis category handling', () => {
  it('normalizes a near-miss instead of dropping it to null', () => {
    const a = parseAnalysis(JSON.stringify({ category: 'Mixin' }), snippet);
    expect(a.category).toBe('coremods-mixins');
  });

  it('reports unplaceable labels but stays silent on a genuine null', () => {
    const rejected: string[] = [];
    parseAnalysis(JSON.stringify({ category: 'not-a-category' }), snippet, (r) => rejected.push(r));
    expect(rejected).toEqual(['not-a-category']);

    rejected.length = 0;
    parseAnalysis(JSON.stringify({ category: null }), snippet, (r) => rejected.push(r));
    expect(rejected).toEqual([]);
  });

  it('de-duplicates tags after normalization', () => {
    const a = parseAnalysis(
      JSON.stringify({ tags: ['Forge 1.12.2', 'forge-1.12.2', 'mixin', ''] }),
      snippet
    );
    expect(a.tags).toEqual(['forge-1-12-2', 'mixin']);
  });
});

describe('renderPromptTemplate', () => {
  it('substitutes the generated category block', () => {
    const out = renderPromptTemplate(`before\n${CATEGORY_LIST_PLACEHOLDER}\nafter`);
    expect(out).not.toContain(CATEGORY_LIST_PLACEHOLDER);
    expect(out).toContain('`tile-entities`');
    expect(out).toContain('`cross-platform`');
  });

  it('leaves a template without the placeholder untouched', () => {
    expect(renderPromptTemplate('no placeholder here')).toBe('no placeholder here');
  });
});
