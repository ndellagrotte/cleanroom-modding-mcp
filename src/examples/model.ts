/**
 * Shared data model for the mod-examples indexing pipeline:
 * acquire (download) -> select (snippets) -> analyze (LLM) -> srg-link
 * (resolve SRG + framework symbols) -> ingest.
 *
 * Mirrors the Phase 3 src/cleanroom-api/model.ts convention: plain interfaces,
 * no runtime deps leaking into public signatures, so the runtime server never
 * pulls the pipeline in.
 */

import type { Loader } from '../loaders.js';

// ─────────────────────────────────────────────────────────────────────────────
// Roster manifest (data/examples-roster.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface LicenseReview {
  verdict: 'approved' | 'rejected' | 'pending';
  by: string;
  date: string;
  notes?: string;
}

export interface RosterRepo {
  /** Display name, e.g. 'GregTech'. */
  name: string;
  /** 'owner/name'. */
  repo: string;
  /** Branch or tag the SHA was resolved from. */
  ref: string;
  /** Pinned commit SHA (the reproducibility + change-detection key). */
  sha: string;
  loader: Loader;
  license: string;
  licenseReview: LicenseReview;
  /** Glob(s) of files to include; empty/absent = match all. */
  include: string[];
  /** Glob(s) to exclude (applied after include). */
  exclude?: string[];
  /** Null = unbounded (small teaching repos); otherwise a hard per-repo cap. */
  maxSnippetsPerRepo: number | null;
  /** Files larger than this (bytes) are skipped and logged. */
  maxFileBytes: number;
  /** Optional per-repo star count / description overrides for the mods row. */
  description?: string;
  starCount?: number;
  minecraftVersions?: string[];
}

export interface Roster {
  schema: number;
  /** Default per-snippet line cap (excerpt discipline); repos may not override in v1. */
  snippetLineCap?: number;
  repos: RosterRepo[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline values
// ─────────────────────────────────────────────────────────────────────────────

/** A raw source file pulled from a repo zipball. */
export interface RawFile {
  /** Repo-relative path, e.g. 'src/main/java/gregtech/api/GTValues.java'. */
  path: string;
  /** File contents (may be omitted in pure-unit tests that only exercise caps). */
  content?: string;
  /** Byte length (content?.length when content is present). */
  bytes: number;
}

/** Selection constraints for one repo (decoupled from RosterRepo for testability). */
export interface SelectConfig {
  repo: string;
  modName?: string;
  loader?: Loader;
  license?: string;
  include?: string[];
  exclude?: string[];
  maxFileBytes: number;
  maxSnippetsPerRepo: number | null;
  /** Regions longer than this are dropped (logged); the excerpt discipline. */
  maxSnippetLines?: number;
  /** For building the github blob file_url. */
  ref?: string;
}

/** A coherent class/method region with file/line provenance. */
export interface Snippet {
  repo: string;
  modName: string;
  loader: Loader;
  license: string;
  filePath: string;
  fileUrl: string;
  startLine: number;
  endLine: number;
  code: string;
  language: string;
  /** Fully-qualified import paths detected in the source file. */
  imports: string[];
}

/** A framework/vanilla symbol an example references (pre-enrichment). */
export interface RawApiReference {
  className: string;
  methodName?: string;
  apiType?: string;
}

/** Structured LLM analysis of a snippet (the analysis columns). */
export interface Analysis {
  title: string;
  caption: string;
  explanation: string;
  /** EXAMPLE_CATEGORIES slug; null when the model can't place it. */
  category: string | null;
  patternType: string;
  complexity: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  qualityScore: number;
  bestPractices: string[];
  potentialPitfalls: string[];
  useCases: string[];
  keywords: string[];
  minecraftConcepts: string[];
  tags: string[];
  apiReferences: RawApiReference[];
}

export interface AnalyzedSnippet {
  snippet: Snippet;
  analysis: Analysis;
}

/** An api_references row after index-time SRG + cleanroom-api resolution. */
export interface ResolvedApiReference {
  className: string;
  methodName: string | null;
  apiType: string | null;
  srgName: string | null;
  resolvedName: string | null;
  apiFqn: string | null;
  apiKind: string | null;
}

/** An ingest-ready example record (mod + example + children). */
export interface ExampleRecord {
  modName: string;
  modRepo: string;
  loader: string;
  license: string;
  filePath: string;
  fileUrl: string;
  startLine: number;
  endLine: number;
  title: string;
  code: string;
  language: string;
  caption: string;
  explanation: string;
  patternType: string;
  complexity: string;
  categorySlug: string | null;
  bestPractices: string[];
  potentialPitfalls: string[];
  useCases: string[];
  keywords: string[];
  minecraftConcepts: string[];
  qualityScore: number;
  isFeatured: boolean;
  tags: string[];
  imports: Array<{ path: string; type: string | null; isCritical: boolean }>;
  apiReferences: ResolvedApiReference[];
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM client (injectable so goldens run offline against a fake)
// ─────────────────────────────────────────────────────────────────────────────

/** Token usage from an OpenAI-compatible response's `usage` block (null when omitted). */
export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** A completion plus its usage block (local endpoints may omit usage → null). */
export interface Completion {
  text: string;
  usage: CompletionUsage | null;
}

export interface LlmClient {
  /** Model identifier, recorded in metadata + analysis_version. */
  readonly model: string;
  /** Return the completion (text + usage) for a prompt. */
  complete(prompt: string, opts?: { temperature?: number }): Promise<Completion>;
}

/** analyzeSnippet's result: the normalized analysis plus the call's usage. */
export interface AnalyzeOutcome {
  analysis: Analysis;
  usage: CompletionUsage | null;
}

/**
 * Maintainer-declared list prices (per 1M tokens) from data/examples-llm.json.
 * Used ONLY for estimation, budget enforcement, and provenance — the pipeline
 * never fetches prices (Phase 5 Revision 1, §4.1).
 */
export interface LlmPricing {
  inputPer1M: number;
  outputPer1M: number;
  currency: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest provenance
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestMeta {
  analysisVersion: string;
  promptVersion: string;
  llmModel: string;
  /** repo -> resolved SHA. */
  rosterPins: Record<string, string>;
  /** repo -> license review record. */
  licenseReview: Record<string, LicenseReview & { license: string }>;
  /**
   * Host of the LLM endpoint (`new URL(baseUrl).host`, '' on parse failure) —
   * provenance without leaking internal network topology. Additive Revision 1
   * key; absent in golden builds.
   */
  llmBaseHost?: string;
  /**
   * JSON-serialized run ledger ({ prompt_tokens, completion_tokens, calls,
   * cache_hits, cache_writes, tokens_saved, estimated_usd, pricing }).
   * Additive Revision 1 key; absent in golden builds.
   */
  llmCost?: string;
}

export interface IngestCounts {
  mods: number;
  examples: number;
  /** Category rows SEEDED (always EXAMPLE_CATEGORIES.length) — not usage. */
  categories: number;
  tags: number;
  imports: number;
  apiReferences: number;
  srgResolved: number;
  apiResolved: number;
  byLoader: Record<string, number>;
  /** Examples ingested with no category — the metric `categories` never was. */
  uncategorized: number;
  /** Examples per category slug; slugs with zero examples are omitted. */
  byCategory: Record<string, number>;
}

/** Simple logger sink used across the pure pipeline stages. */
export interface PipelineLogger {
  log(message: string): void;
}
