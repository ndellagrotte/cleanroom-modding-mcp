/**
 * SRG + cleanroom-api cross-linking (pipeline stage 4).
 *
 * At index time, scans each snippet for 1.12.2 SRG tokens (func_/field_) and
 * resolves them against the build machine's mappings.db; and resolves framework
 * symbols the analysis references against the build machine's cleanroom-api.db
 * (DESIGN §8). Both joins are index-time and degrade to NULL when the source DB
 * is absent — examples.db never hard-depends on either at runtime (§8.1/§8.3).
 */

import { detectSymbolKind } from '../mappings/symbol-kind.js';
import type { MappingsService, ResolvedSymbol } from '../services/mappings-service.js';
import type { CleanroomApiService } from '../services/cleanroom-api-service.js';
import type { AnalyzedSnippet, ExampleRecord, ResolvedApiReference } from './model.js';

export interface LinkDeps {
  /** Build-machine mappings.db service, or null when absent (SRG un-enriched). */
  mappings: MappingsService | null;
  /** Build-machine cleanroom-api.db service, or null when absent (api un-enriched). */
  api: CleanroomApiService | null;
  /** SRG era version; 1.12.2 by default. */
  minecraftVersion?: string;
}

const SRG_TOKEN = /\b(?:func|field)_\d+_[a-zA-Z]+_?\b/g;

/** Unique SRG method/field tokens appearing in a snippet's code. */
export function scanSrgTokens(code: string): string[] {
  const found = code.match(SRG_TOKEN);
  return found ? [...new Set(found)] : [];
}

/** Map a cleanroom-api type kind onto the frozen api_kind set. */
function apiKind(kind: string, isEvent: boolean): string {
  if (isEvent) return 'event';
  if (kind === 'record') return 'class';
  return kind; // class | interface | enum | annotation
}

function isSrg(name: string): boolean {
  const k = detectSymbolKind(name);
  return k === 'srg-method' || k === 'srg-field' || k === 'srg-param' || k === 'srg-ctor-param';
}

/**
 * Resolve one snippet's api_references: the analysis-provided framework symbols
 * (resolved against cleanroom-api.db) plus code-scanned SRG tokens (resolved
 * against mappings.db). Deduplicated by (class_name, method_name, srg_name).
 */
export function resolveApiReferences(
  analyzed: AnalyzedSnippet,
  deps: LinkDeps
): ResolvedApiReference[] {
  const version = deps.minecraftVersion ?? '1.12.2';
  const out: ResolvedApiReference[] = [];
  const seen = new Set<string>();

  const push = (ref: ResolvedApiReference): void => {
    const key = `${ref.className}|${ref.methodName ?? ''}|${ref.srgName ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  // Pre-resolve every SRG token in one batched pass (analysis refs + code scan).
  const srgTokens = new Set<string>(scanSrgTokens(analyzed.snippet.code));
  for (const r of analyzed.analysis.apiReferences) {
    if (r.methodName && isSrg(r.methodName)) srgTokens.add(r.methodName);
    if (isSrg(r.className)) srgTokens.add(r.className);
  }
  const srgResolved: Map<string, ResolvedSymbol> = deps.mappings
    ? deps.mappings.resolveSymbols([...srgTokens], version)
    : new Map<string, ResolvedSymbol>();

  const resolveSrgRow = (token: string, apiType: string): ResolvedApiReference => {
    const resolved = srgResolved.get(token);
    const result = resolved?.result ?? null;
    return {
      className: result?.className ?? token,
      methodName: token,
      apiType,
      srgName: token,
      resolvedName: result?.name ?? null,
      apiFqn: null,
      apiKind: null,
    };
  };

  // 1) Framework symbols the analysis named — resolve against cleanroom-api.db.
  for (const r of analyzed.analysis.apiReferences) {
    if (isSrg(r.className) || (r.methodName && isSrg(r.methodName))) {
      const token = isSrg(r.className) ? r.className : r.methodName!;
      push(resolveSrgRow(token, r.apiType ?? 'vanilla'));
      continue;
    }
    let apiFqn: string | null = null;
    let kind: string | null = null;
    if (deps.api) {
      const lookup = deps.api.getTypeByName(r.className);
      if (lookup.match) {
        apiFqn = lookup.match.fqn;
        kind = apiKind(lookup.match.kind, lookup.match.isEvent);
      }
    }
    push({
      className: r.className,
      methodName: r.methodName ?? null,
      apiType: r.apiType ?? (apiFqn ? 'forge' : null),
      srgName: null,
      resolvedName: null,
      apiFqn,
      apiKind: kind,
    });
  }

  // 2) Code-scanned SRG tokens — always recorded (enriched when mappings present).
  for (const token of scanSrgTokens(analyzed.snippet.code)) {
    push(resolveSrgRow(token, 'vanilla'));
  }

  return out;
}

/** Classify an import path into an api_type-style bucket. */
function importType(path: string): string {
  if (path.startsWith('net.minecraftforge.')) return 'forge';
  if (path.startsWith('net.minecraft.')) return 'vanilla';
  if (path.startsWith('com.cleanroommc.') || path.startsWith('zone.rong.')) return 'cleanroom';
  return 'library';
}

/** An import is "critical" when its simple name is used in the snippet body. */
function isCriticalImport(path: string, code: string): boolean {
  const simple = path.split('.').pop();
  if (!simple || simple === '*') return false;
  return new RegExp(`\\b${simple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code);
}

/** Assemble an ingest-ready ExampleRecord from an analyzed+linked snippet. */
export function toExampleRecord(
  analyzed: AnalyzedSnippet,
  apiReferences: ResolvedApiReference[]
): ExampleRecord {
  const { snippet, analysis } = analyzed;
  return {
    modName: snippet.modName,
    modRepo: snippet.repo,
    loader: snippet.loader,
    license: snippet.license,
    filePath: snippet.filePath,
    fileUrl: snippet.fileUrl,
    startLine: snippet.startLine,
    endLine: snippet.endLine,
    title: analysis.title,
    code: snippet.code,
    language: snippet.language,
    caption: analysis.caption,
    explanation: analysis.explanation,
    patternType: analysis.patternType,
    complexity: analysis.complexity,
    categorySlug: analysis.category,
    bestPractices: analysis.bestPractices,
    potentialPitfalls: analysis.potentialPitfalls,
    useCases: analysis.useCases,
    keywords: analysis.keywords,
    minecraftConcepts: analysis.minecraftConcepts,
    qualityScore: analysis.qualityScore,
    isFeatured: analysis.qualityScore >= 0.7,
    tags: analysis.tags,
    imports: snippet.imports.map((path) => ({
      path,
      type: importType(path),
      isCritical: isCriticalImport(path, snippet.code),
    })),
    apiReferences,
  };
}
