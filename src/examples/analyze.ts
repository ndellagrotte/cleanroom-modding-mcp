/**
 * LLM analysis (pipeline stage 3).
 *
 * Each selected snippet is sent to a pluggable OpenAI-compatible endpoint with
 * the committed, versioned prompt (src/examples/prompts/); the model returns
 * strict JSON for the analysis columns. Determinism is the whole point of
 * Phase 5 (DESIGN §6.4): the model is pinned, temperature defaults to 0
 * (overridable per endpoint — some endpoints reject 0, and some, e.g.
 * Moonshot's kimi-k2.6, must not be sent a temperature at all), and
 * `analysis_version` is derived from (prompt_version + model + pipeline logic
 * + effective request knobs) so any change invalidates prior analyses.
 *
 * A configured endpoint is REQUIRED (Fixed Input 1): with none set the caller
 * exits with a clear error and touches nothing. There is no degraded build.
 */

import crypto from 'crypto';
import { jsonrepair } from 'jsonrepair';
import { EXAMPLE_CATEGORIES, buildCategoryPromptBlock } from '../categories.js';
import type {
  Analysis,
  AnalyzeOutcome,
  CompletionUsage,
  LlmClient,
  RawApiReference,
  Snippet,
} from './model.js';

/**
 * Revision of the pipeline's analysis logic. Bump when the prompt-independent
 * shape of the analysis changes (parsing, normalization, category mapping) so
 * `analysis_version` moves even if the prompt file text is unchanged.
 */
export const PIPELINE_REV = '2';

const COMPLEXITIES = new Set(['beginner', 'intermediate', 'advanced', 'expert']);
const CATEGORY_SET = new Set<string>(EXAMPLE_CATEGORIES);

/**
 * Near-miss labels the model reaches for that aren't EXAMPLE_CATEGORIES slugs.
 * Applied only after slugification (lowercase, hyphen-separated) fails an exact
 * match, so this table holds genuine synonyms and singular/plural variants —
 * not casing or punctuation, which `slugifyCategory` already absorbs.
 */
const CATEGORY_ALIASES: Record<string, string> = {
  // singular/plural
  block: 'blocks',
  item: 'items',
  entity: 'entities',
  'tile-entity': 'tile-entities',
  tileentity: 'tile-entities',
  tileentities: 'tile-entities',
  event: 'events',
  recipe: 'recipes',
  command: 'commands',
  sound: 'sounds',
  particle: 'particles',
  capability: 'capabilities',
  // synonyms
  render: 'rendering',
  renderer: 'rendering',
  model: 'rendering',
  models: 'rendering',
  ui: 'gui',
  guis: 'gui',
  container: 'gui',
  containers: 'gui',
  widget: 'gui',
  widgets: 'gui',
  net: 'networking',
  network: 'networking',
  packet: 'networking',
  packets: 'networking',
  'world-generation': 'worldgen',
  'world-gen': 'worldgen',
  worldgeneration: 'worldgen',
  registration: 'registry',
  registries: 'registry',
  mixin: 'coremods-mixins',
  mixins: 'coremods-mixins',
  coremod: 'coremods-mixins',
  coremods: 'coremods-mixins',
  'coremod-mixins': 'coremods-mixins',
  asm: 'coremods-mixins',
  api: 'api-design',
  'api-surface': 'api-design',
  proxy: 'cross-platform',
  proxies: 'cross-platform',
  sided: 'cross-platform',
  sidedness: 'cross-platform',
  'client-server': 'cross-platform',
  'sided-proxy': 'cross-platform',
  crossplatform: 'cross-platform',
  storage: 'storage-systems',
  'storage-system': 'storage-systems',
  inventory: 'storage-systems',
  inventories: 'storage-systems',
  fluid: 'storage-systems',
  fluids: 'storage-systems',
  energy: 'storage-systems',
  animations: 'animation',
  configuration: 'config',
  configs: 'config',
};

/**
 * Coerce a free-form label into slug shape: strip wrapping backticks/quotes
 * (the prompt renders slugs in backticks, and models echo them), lowercase,
 * and collapse whitespace/underscores/dots/slashes into single hyphens.
 */
function slugifyCategory(raw: string): string {
  return raw
    .trim()
    .replace(/^[`'"\s]+|[`'"\s.,;:]+$/g, '')
    .toLowerCase()
    .replace(/[\s._/\\]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Map the model's raw `category` onto an EXAMPLE_CATEGORIES slug.
 *
 * Returns `rejected` (the raw string) only when the model DID emit a label and
 * it could not be placed — that's the signal worth counting. A non-string
 * (absent, or an explicit JSON `null`) is the model legitimately declining, so
 * both fields come back null and nothing is reported.
 *
 * v1 did a bare `CATEGORY_SET.has(raw)` with no normalization and discarded the
 * raw value, which made every rejection indistinguishable from a decline.
 */
export function normalizeCategory(raw: unknown): { slug: string | null; rejected: string | null } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { slug: null, rejected: null };
  }
  const slug = slugifyCategory(raw);
  if (CATEGORY_SET.has(slug)) return { slug, rejected: null };
  // 'null'/'none' spelled as a string is a decline, not a failed label.
  if (slug === 'null' || slug === 'none' || slug === 'n-a') {
    return { slug: null, rejected: null };
  }
  const alias = CATEGORY_ALIASES[slug];
  if (alias) return { slug: alias, rejected: null };
  return { slug: null, rejected: raw };
}

/**
 * Normalize a tag slug so one concept is one tag. The v1 corpus carried
 * `forge-1.12.2`, `forge-1-12-2` and `forge 1.12.2` as three separate rows in
 * the `tags` table; all three converge here.
 */
export function normalizeTagSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s._/\\]+/g, '-')
    .replace(/[^a-z0-9+#-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Normalize, drop empties, and de-duplicate a tag list, preserving order. */
function normalizeTags(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const slug = normalizeTagSlug(value);
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// analysis_version
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical JSON with stable key order (undefined values dropped), so the
 * request-knob component of analysis_version never wobbles with object key
 * insertion order.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Stable id over (prompt version + model + pipeline logic + request knobs). */
export function computeAnalysisVersion(parts: {
  promptVersion: string;
  model: string;
  pipelineRev: string;
  /**
   * The effective request knobs that shape the completion (temperature,
   * extraBody). Canonicalized before hashing — any change to them invalidates
   * prior analyses and cache rows exactly like a model change does.
   */
  requestKnobs?: Record<string, unknown>;
}): string {
  const h = crypto
    .createHash('sha256')
    .update(
      `${parts.promptVersion}\n${parts.model}\n${parts.pipelineRev}\n` +
        canonicalJson(parts.requestKnobs ?? null)
    )
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
  /**
   * Request temperature; null = omit the field entirely so the endpoint's own
   * default applies (some endpoints, e.g. Moonshot's kimi-k2.6, reject or
   * ignore an explicit temperature). resolveEndpointConfig materializes the
   * frozen default 0 when nothing declares a value, so null only reaches the
   * client from an explicit `"temperature": null` in the config file.
   */
  temperature: number | null;
  /**
   * Provider-specific request-body extensions merged verbatim into every
   * chat-completions call (e.g. Moonshot's `"thinking": {"type": "disabled"}`).
   * Comes only from the committed config file — the pipeline code stays
   * provider-agnostic (Revision 1, D1). Code-controlled keys (model, messages,
   * temperature-when-set) always win on conflict.
   */
  extraBody?: Record<string, unknown>;
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
 * The non-secret committed config-file layer (data/examples-llm.json) — the
 * lowest endpoint precedence tier (Phase 5 Revision 1, §4.1). The API key is
 * NEVER in this file; it comes from CLEANROOM_MCP_LLM_API_KEY/--llm-api-key
 * only.
 */
export interface EndpointFileConfig {
  baseUrl?: string;
  model?: string;
  /**
   * Number: the value the endpoint requires (some endpoints reject 0 with
   * HTTP 400). Explicit null: omit the temperature field entirely. Absent:
   * the frozen determinism default 0.
   */
  temperature?: number | null;
  /**
   * Provider-specific request-body extensions (see EndpointConfig.extraBody).
   * File-only: there is deliberately no env/flag carrier for this — provider
   * quirks live in the committed, PR-reviewed declaration.
   */
  extraBody?: Record<string, unknown>;
}

function parseTemperature(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the endpoint from CLI flags (highest precedence), then environment,
 * then the committed config file. Throws EndpointNotConfiguredError when base
 * URL or model is missing — the caller turns that into a clean non-zero exit
 * that writes nothing.
 */
export function resolveEndpointConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  file: EndpointFileConfig = {}
): EndpointConfig {
  const baseUrl =
    flagValue(argv, '--llm-base-url') ?? env.CLEANROOM_MCP_LLM_BASE_URL ?? file.baseUrl ?? '';
  const apiKey = flagValue(argv, '--llm-api-key') ?? env.CLEANROOM_MCP_LLM_API_KEY ?? null;
  const model = flagValue(argv, '--llm-model') ?? env.CLEANROOM_MCP_LLM_MODEL ?? file.model ?? '';
  const temperature =
    parseTemperature(flagValue(argv, '--llm-temperature')) ??
    parseTemperature(env.CLEANROOM_MCP_LLM_TEMPERATURE) ??
    // File layer: number → that value; explicit null → omit the field;
    // absent → the frozen determinism default 0.
    (file.temperature !== undefined ? file.temperature : 0);

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
  return {
    baseUrl: baseUrl.trim().replace(/\/$/, ''),
    apiKey,
    model: model.trim(),
    temperature,
    extraBody: file.extraBody,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An HTTP failure from the LLM endpoint; `status` drives retry classification. */
export class LlmHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LlmHttpError';
    this.status = status;
  }
}

/**
 * Retry classification (Phase 5 Revision 1, §4.6 — no double-pay on permanent
 * failures). Transient: network errors (fetch surfaces them as TypeError),
 * 429, and 5xx — the orchestrator may make a single second attempt. Permanent:
 * other 4xx (400/401/404/…) and JSON extraction failures — skip immediately.
 */
export function isTransientLlmError(err: unknown): boolean {
  if (err instanceof LlmHttpError) {
    return err.status === 429 || (err.status >= 500 && err.status <= 599);
  }
  return err instanceof TypeError;
}

/** Parse an OpenAI-compatible `usage` block; local endpoints may omit it. */
function parseUsage(raw: unknown): CompletionUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  if (typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') {
    return null;
  }
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    totalTokens:
      typeof u.total_tokens === 'number' ? u.total_tokens : u.prompt_tokens + u.completion_tokens,
  };
}

/**
 * An OpenAI-compatible chat client (LM Studio, vLLM, OpenAI, GitHub Models,
 * Moonshot, …). The request body is `{ ...cfg.extraBody, model, messages,
 * temperature? }`: provider extensions come from the committed config file,
 * code-controlled keys always win, and temperature is omitted entirely when
 * `EndpointConfig.temperature` is null (some endpoints reject/ignore an
 * explicit value). When the server echoes a different model id than the
 * pinned one (silent provider-side aliasing), `onModelMismatch` fires once
 * per client. Rate-limit / transient responses (429/503)
 * are retried with backoff honoring `Retry-After` — important for GitHub Models,
 * whose free tier enforces tight per-minute request limits. `maxRetries`
 * (default 5) is the `--llm-max-retries` knob.
 */
export function createOpenAiClient(
  cfg: EndpointConfig,
  opts?: {
    maxRetries?: number;
    /** Fires once when the served model id differs from the requested one. */
    onModelMismatch?: (served: string, requested: string) => void;
  }
): LlmClient {
  const MAX_RETRIES = opts?.maxRetries ?? 5;
  const MAX_RETRY_AFTER_S = 90;
  const onModelMismatch =
    opts?.onModelMismatch ??
    ((served: string, requested: string) =>
      console.warn(
        `LLM endpoint served model '${served}' but '${requested}' was requested — ` +
          'the provider may be aliasing the model id.'
      ));
  let mismatchWarned = false;
  return {
    model: cfg.model,
    async complete(prompt: string, completeOpts?: { temperature?: number }) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) {
        headers.Authorization = `Bearer ${cfg.apiKey}`;
      }
      // Per-call override → configured endpoint temperature → omitted (null).
      const temperature = completeOpts?.temperature ?? cfg.temperature;
      const body = JSON.stringify({
        // Provider extensions first so code-controlled keys always win.
        ...cfg.extraBody,
        model: cfg.model,
        messages: [
          {
            role: 'system',
            content: 'You are a precise code analyst. Return only the requested JSON object.',
          },
          { role: 'user', content: prompt },
        ],
        ...(temperature !== null ? { temperature } : {}),
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
            model?: unknown;
            choices?: Array<{ message?: { content?: string } }>;
            usage?: unknown;
          };
          if (!mismatchWarned && typeof data.model === 'string' && data.model !== cfg.model) {
            mismatchWarned = true;
            onModelMismatch(data.model, cfg.model);
          }
          const content = data.choices?.[0]?.message?.content;
          if (typeof content !== 'string') {
            throw new Error('LLM endpoint returned no message content');
          }
          return { text: content, usage: parseUsage(data.usage) };
        }
        if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
          const retryAfter = Number(res.headers.get('retry-after'));
          // A short Retry-After is a per-minute limit worth waiting out; a long
          // one is a daily/window limit — don't block for minutes on one snippet,
          // fail fast so the orchestrator skips it and moves on.
          if (Number.isFinite(retryAfter) && retryAfter > MAX_RETRY_AFTER_S) {
            throw new LlmHttpError(
              res.status,
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
        throw new LlmHttpError(
          res.status,
          `LLM endpoint HTTP ${res.status}: ${await res.text().catch(() => '')}`
        );
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Analyze one snippet
// ─────────────────────────────────────────────────────────────────────────────

/** The `{{CATEGORY_LIST}}` placeholder the prompt template carries. */
export const CATEGORY_LIST_PLACEHOLDER = '{{CATEGORY_LIST}}';

/**
 * Substitute the generated allowed-category block into the prompt template, so
 * the taxonomy the model sees always comes from EXAMPLE_CATEGORIES rather than
 * a hand-copied list in the markdown. A template without the placeholder is
 * returned unchanged (the golden fixture's stub prompts don't carry one).
 *
 * Exported so the orchestrator can hash the RENDERED template into
 * analysis_version — otherwise editing the prompt (or a category description)
 * would change what the model sees without invalidating a single cache row.
 */
export function renderPromptTemplate(promptTemplate: string): string {
  return promptTemplate.split(CATEGORY_LIST_PLACEHOLDER).join(buildCategoryPromptBlock());
}

/**
 * The exact prompt body sent to the endpoint for a snippet. Exported so
 * `--estimate` can project input tokens over the REAL prompt bodies (the
 * heuristic's input side is exact; Phase 5 Revision 1, §4.3).
 */
export function buildPrompt(promptTemplate: string, snippet: Snippet): string {
  return (
    `${renderPromptTemplate(promptTemplate)}\n\n` +
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

/**
 * Parse the model's raw completion into a normalized, validated Analysis.
 *
 * `onRejectedCategory` fires when the model emitted a category label that could
 * not be placed even after normalization — the orchestrator tallies these so a
 * taxonomy mismatch shows up in the build summary instead of silently becoming
 * a NULL column.
 */
export function parseAnalysis(
  raw: string,
  snippet: Snippet,
  onRejectedCategory?: (rawCategory: string) => void
): Analysis {
  const parsed = extractJsonObject(raw);

  const quality =
    typeof parsed.quality_score === 'number' ? Math.max(0, Math.min(1, parsed.quality_score)) : 0.5;
  const complexityRaw = typeof parsed.complexity === 'string' ? parsed.complexity : '';
  const category = normalizeCategory(parsed.category);
  if (category.rejected !== null) {
    onRejectedCategory?.(category.rejected);
  }

  return {
    title:
      typeof parsed.title === 'string' && parsed.title.trim()
        ? parsed.title.trim()
        : snippet.filePath,
    caption: typeof parsed.caption === 'string' ? parsed.caption : '',
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
    category: category.slug,
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
    tags: normalizeTags(asStringArray(parsed.tags)),
    apiReferences: normalizeApiRefs(parsed.api_references),
  };
}

/**
 * Heuristic token estimate: 4 chars/token (Phase 5 Revision 1, §4.3). Used for
 * the `--estimate` projection only — budget enforcement uses actual usage.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Send one snippet to the endpoint; return the normalized analysis + usage.
 * Temperature is the client's configured endpoint default (0 unless the
 * endpoint config says otherwise — some endpoints reject 0).
 */
export async function analyzeSnippet(
  snippet: Snippet,
  client: LlmClient,
  promptTemplate: string,
  onRejectedCategory?: (rawCategory: string) => void
): Promise<AnalyzeOutcome> {
  const completion = await client.complete(buildPrompt(promptTemplate, snippet));
  return {
    analysis: parseAnalysis(completion.text, snippet, onRejectedCategory),
    usage: completion.usage,
  };
}
