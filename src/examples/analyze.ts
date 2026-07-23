/**
 * LLM analysis (pipeline stage 3).
 *
 * Each selected snippet is sent to a pluggable OpenAI-compatible endpoint with
 * the committed, versioned prompt (src/examples/prompts/); the model returns
 * strict JSON for the analysis columns. Determinism is the whole point of
 * Phase 5 (DESIGN §6.4): the model is pinned, temperature is 0, and
 * `analysis_version` is derived from (prompt_version + model + pipeline logic)
 * so any change invalidates prior analyses.
 *
 * A configured endpoint is REQUIRED (Fixed Input 1): with none set the caller
 * exits with a clear error and touches nothing. There is no degraded build.
 */

import crypto from 'crypto';
import { jsonrepair } from 'jsonrepair';
import { EXAMPLE_CATEGORIES } from '../categories.js';
import type { Analysis, LlmClient, RawApiReference, Snippet } from './model.js';

/**
 * Revision of the pipeline's analysis logic. Bump when the prompt-independent
 * shape of the analysis changes (parsing, normalization, category mapping) so
 * `analysis_version` moves even if the prompt file text is unchanged.
 */
export const PIPELINE_REV = '1';

const COMPLEXITIES = new Set(['beginner', 'intermediate', 'advanced', 'expert']);
const CATEGORY_SET = new Set<string>(EXAMPLE_CATEGORIES);

// ─────────────────────────────────────────────────────────────────────────────
// analysis_version
// ─────────────────────────────────────────────────────────────────────────────

/** Stable id over (prompt version + model + pipeline logic). */
export function computeAnalysisVersion(parts: {
  promptVersion: string;
  model: string;
  pipelineRev: string;
}): string {
  const h = crypto
    .createHash('sha256')
    .update(`${parts.promptVersion}\n${parts.model}\n${parts.pipelineRev}`)
    .digest('hex');
  return `av1-${h.slice(0, 16)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint configuration (env vars + CLI flags; a configured endpoint is required)
// ─────────────────────────────────────────────────────────────────────────────

export interface EndpointConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

export class EndpointNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointNotConfiguredError';
  }
}

function flagValue(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  const next = idx !== -1 ? argv[idx + 1] : undefined;
  return next && !next.startsWith('--') ? next : null;
}

/**
 * Resolve the endpoint from CLI flags (highest precedence) then environment.
 * Throws EndpointNotConfiguredError when base URL or model is missing — the
 * caller turns that into a clean non-zero exit that writes nothing.
 */
export function resolveEndpointConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): EndpointConfig {
  const baseUrl = flagValue(argv, '--llm-base-url') ?? env.CLEANROOM_MCP_LLM_BASE_URL ?? '';
  const apiKey = flagValue(argv, '--llm-api-key') ?? env.CLEANROOM_MCP_LLM_API_KEY ?? null;
  const model = flagValue(argv, '--llm-model') ?? env.CLEANROOM_MCP_LLM_MODEL ?? '';

  if (!baseUrl.trim() || !model.trim()) {
    throw new EndpointNotConfiguredError(
      'A configured LLM endpoint is required to (re)build the examples corpus.\n' +
        'Set both a base URL and a model, via env vars or flags:\n' +
        '  CLEANROOM_MCP_LLM_BASE_URL / --llm-base-url   (e.g. http://localhost:1234/v1)\n' +
        '  CLEANROOM_MCP_LLM_MODEL    / --llm-model       (the model id to pin)\n' +
        '  CLEANROOM_MCP_LLM_API_KEY  / --llm-api-key      (optional for local endpoints)\n' +
        'CI never calls an endpoint; it carries the previous examples.db forward.'
    );
  }
  return { baseUrl: baseUrl.trim().replace(/\/$/, ''), apiKey, model: model.trim() };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * An OpenAI-compatible chat client (LM Studio, vLLM, OpenAI, GitHub Models, …).
 * Analysis calls pin temperature 0. Rate-limit / transient responses (429/503)
 * are retried with backoff honoring `Retry-After` — important for GitHub Models,
 * whose free tier enforces tight per-minute request limits.
 */
export function createOpenAiClient(cfg: EndpointConfig): LlmClient {
  const MAX_RETRIES = 5;
  const MAX_RETRY_AFTER_S = 90;
  return {
    model: cfg.model,
    async complete(prompt: string, opts?: { temperature?: number }): Promise<string> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) {
        headers.Authorization = `Bearer ${cfg.apiKey}`;
      }
      const body = JSON.stringify({
        model: cfg.model,
        temperature: opts?.temperature ?? 0,
        messages: [
          {
            role: 'system',
            content: 'You are a precise code analyst. Return only the requested JSON object.',
          },
          { role: 'user', content: prompt },
        ],
      });

      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(120_000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = data.choices?.[0]?.message?.content;
          if (typeof content !== 'string') {
            throw new Error('LLM endpoint returned no message content');
          }
          return content;
        }
        if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
          const retryAfter = Number(res.headers.get('retry-after'));
          // A short Retry-After is a per-minute limit worth waiting out; a long
          // one is a daily/window limit — don't block for minutes on one snippet,
          // fail fast so the orchestrator skips it and moves on.
          if (Number.isFinite(retryAfter) && retryAfter > MAX_RETRY_AFTER_S) {
            throw new Error(
              `LLM endpoint rate-limited (Retry-After ${retryAfter}s exceeds ${MAX_RETRY_AFTER_S}s cap)`
            );
          }
          const waitMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : Math.min(60_000, 1000 * 2 ** attempt);
          await sleep(waitMs);
          continue;
        }
        throw new Error(`LLM endpoint HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Analyze one snippet
// ─────────────────────────────────────────────────────────────────────────────

function buildPrompt(promptTemplate: string, snippet: Snippet): string {
  return (
    `${promptTemplate}\n\n` +
    `## Snippet to analyze\n` +
    `Mod: ${snippet.modName} (${snippet.repo})\n` +
    `File: ${snippet.filePath} (lines ${snippet.startLine}-${snippet.endLine})\n\n` +
    '```java\n' +
    `${snippet.code}\n` +
    '```\n\n' +
    'Return ONLY the JSON object described above — no prose, no code fences.'
  );
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

function normalizeApiRefs(value: unknown): RawApiReference[] {
  if (!Array.isArray(value)) return [];
  const out: RawApiReference[] = [];
  for (const raw of value) {
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      const className = typeof r.class_name === 'string' ? r.class_name : undefined;
      if (!className) continue;
      out.push({
        className,
        methodName: typeof r.method_name === 'string' ? r.method_name : undefined,
        apiType: typeof r.api_type === 'string' ? r.api_type : undefined,
      });
    }
  }
  return out;
}

/**
 * Extract the analysis object from a raw completion, tolerating a prose preamble,
 * markdown fences, and code fences that appear *inside* string values. Strategy:
 * try a direct parse (clean JSON); else take the outermost brace span (first `{`
 * to last `}`) and repair it — never fence-strip, which would mis-capture an
 * inner ```java block inside `explanation`. Throws if no object is present (the
 * orchestrator isolates that per snippet).
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    const direct = JSON.parse(trimmed) as unknown;
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    // fall through to brace-span extraction
  }
  // No brace span at all → not JSON; let the caller isolate/skip this snippet
  // rather than let jsonrepair coerce bare prose into a string primitive.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last <= first) {
    throw new Error('LLM completion contained no JSON object');
  }
  const repaired = JSON.parse(jsonrepair(trimmed.slice(first, last + 1))) as unknown;
  // jsonrepair turns newline-concatenated objects into an ARRAY and bare prose
  // into a string — neither is a valid analysis. Reject both so F4 skips them
  // instead of ingesting a phantom default row.
  if (!repaired || typeof repaired !== 'object' || Array.isArray(repaired)) {
    throw new Error('LLM completion did not parse to a JSON object');
  }
  return repaired as Record<string, unknown>;
}

/** Parse the model's raw completion into a normalized, validated Analysis. */
export function parseAnalysis(raw: string, snippet: Snippet): Analysis {
  const parsed = extractJsonObject(raw);

  const quality =
    typeof parsed.quality_score === 'number' ? Math.max(0, Math.min(1, parsed.quality_score)) : 0.5;
  const complexityRaw = typeof parsed.complexity === 'string' ? parsed.complexity : '';
  const categoryRaw = typeof parsed.category === 'string' ? parsed.category : '';

  return {
    title:
      typeof parsed.title === 'string' && parsed.title.trim()
        ? parsed.title.trim()
        : snippet.filePath,
    caption: typeof parsed.caption === 'string' ? parsed.caption : '',
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
    category: CATEGORY_SET.has(categoryRaw) ? categoryRaw : null,
    patternType: typeof parsed.pattern_type === 'string' ? parsed.pattern_type : 'general',
    complexity: (COMPLEXITIES.has(complexityRaw)
      ? complexityRaw
      : 'intermediate') as Analysis['complexity'],
    qualityScore: quality,
    bestPractices: asStringArray(parsed.best_practices),
    potentialPitfalls: asStringArray(parsed.potential_pitfalls),
    useCases: asStringArray(parsed.use_cases),
    keywords: asStringArray(parsed.keywords),
    minecraftConcepts: asStringArray(parsed.minecraft_concepts),
    tags: asStringArray(parsed.tags),
    apiReferences: normalizeApiRefs(parsed.api_references),
  };
}

/** Send one snippet to the endpoint and return the normalized analysis. */
export async function analyzeSnippet(
  snippet: Snippet,
  client: LlmClient,
  promptTemplate: string
): Promise<Analysis> {
  const raw = await client.complete(buildPrompt(promptTemplate, snippet), { temperature: 0 });
  return parseAnalysis(raw, snippet);
}
