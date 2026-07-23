/**
 * Pure validation + compilation for the equivalence corpus (DESIGN §6.2).
 *
 * IMPORTANT: this module is dist-safe — it takes ALREADY-PARSED JavaScript objects and
 * imports no YAML parser. The YAML read happens only in scripts/ (never compiled into
 * dist/), keeping the "no runtime YAML parsing" non-goal intact.
 *
 * Style follows the dependency-averse, defensive hand-rolled parser in
 * src/indexer/markdown.ts: assert shape, return error strings rather than throwing.
 */

import {
  FROM_VOCABS,
  TO_LOADERS,
  EQUIVALENCE_KINDS,
  FROM_ERAS,
  type CompiledEquivalenceEntry,
  type EquivalenceSource,
} from './types.js';
import { TOPIC_SET } from './topics.js';

/** The authored YAML entry shape (nested from/to), before compilation. */
export interface AuthoredEntry {
  from?: {
    vocab?: string;
    era?: string;
    api?: string;
    api_alt?: string[];
    versions?: string;
  };
  to?: {
    loader?: string;
    api?: string;
  };
  kind?: string;
  notes?: string;
  code_before?: string;
  code_after?: string;
  caveats?: string[];
  related?: string[];
  sources?: EquivalenceSource[];
  validated_against?: string;
}

/** A parsed topic file: `{ topic, entries: [...] }`. */
export interface AuthoredTopicFile {
  topic?: string;
  entries?: AuthoredEntry[];
}

const FROM_VOCAB_SET: ReadonlySet<string> = new Set(FROM_VOCABS);
const TO_LOADER_SET: ReadonlySet<string> = new Set(TO_LOADERS);
const KIND_SET: ReadonlySet<string> = new Set(EQUIVALENCE_KINDS);
const ERA_SET: ReadonlySet<string> = new Set(FROM_ERAS);

/** Detect an LGPL-family license by any common spelling (§6.3 non-goal). */
function isLgplFamily(license: string): boolean {
  const lic = license.toUpperCase();
  return (
    lic.includes('LGPL') || lic.includes('LESSER GPL') || lic.includes('LESSER GENERAL PUBLIC')
  );
}

/** Blessed related[] schemes (DESIGN §3.4). */
function isBlessedRelated(ref: string): boolean {
  return (
    ref.startsWith('cleanroom://equivalence/') ||
    ref.startsWith('cleanroom://guide/') ||
    ref.startsWith('cleanroom://template/') ||
    ref.startsWith('api://') ||
    // a bare entry_key: <topic>/<vocab>/<slug>
    /^[^/]+\/[^/]+\/[^/]+/.test(ref)
  );
}

/** Deterministic 32-bit FNV-1a hash (hex), dist-safe (no imports). */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Slugify an API string into the stable entry_key tail. When the slug would exceed 120
 * chars it is truncated with a hash suffix so two long, same-prefix APIs still get distinct
 * keys (avoids a silent entry_key collision that would abort the build).
 */
export function slug(api: string): string {
  const full = api
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (full.length <= 120) return full;
  return `${full.slice(0, 111)}-${shortHash(full)}`;
}

export function deriveEntryKey(topic: string, fromVocab: string, fromApi: string): string {
  return `${topic}/${fromVocab}/${slug(fromApi)}`;
}

/** Compile-derived keyword list: split identifiers from the APIs + topic. */
export function deriveKeywords(entry: {
  topic: string;
  from_api: string;
  from_api_alt: string[];
  to_api: string | null;
}): string[] {
  const bag = [entry.from_api, ...entry.from_api_alt, entry.to_api ?? '', entry.topic].join(' ');
  const tokens = (bag.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 2);
  const unique = Array.from(new Set(tokens));
  // Guarantee non-empty (oracle: keywords json_array_length >= 1).
  return unique.length > 0 ? unique : [entry.topic];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validate + compile one topic file. Returns compiled entries and any error strings
 * (each prefixed with the file name and entry index for actionable output).
 */
export function validateTopicFile(
  file: AuthoredTopicFile,
  fileName: string
): { errors: string[]; entries: CompiledEquivalenceEntry[] } {
  const errors: string[] = [];
  const entries: CompiledEquivalenceEntry[] = [];

  const topic = file.topic;
  if (!isNonEmptyString(topic)) {
    errors.push(`${fileName}: missing "topic"`);
    return { errors, entries };
  }
  if (!TOPIC_SET.has(topic)) {
    errors.push(`${fileName}: topic "${topic}" is not in the canonical taxonomy`);
  }
  if (!Array.isArray(file.entries) || file.entries.length === 0) {
    errors.push(`${fileName}: "entries" must be a non-empty array`);
    return { errors, entries };
  }

  file.entries.forEach((e, i) => {
    const at = `${fileName}[${i}]`;
    const from = e.from ?? {};
    const to = e.to ?? {};

    if (!isNonEmptyString(from.vocab) || !FROM_VOCAB_SET.has(from.vocab)) {
      errors.push(`${at}: from.vocab must be one of ${[...FROM_VOCABS].join(', ')}`);
    }
    if (from.era !== undefined && !ERA_SET.has(from.era)) {
      errors.push(`${at}: from.era "${from.era}" is not a known era`);
    }
    if (!isNonEmptyString(from.api)) {
      errors.push(`${at}: from.api is required`);
    }
    if (from.api_alt !== undefined && !isStringArray(from.api_alt)) {
      errors.push(`${at}: from.api_alt must be an array of strings`);
    }
    if (!isNonEmptyString(to.loader) || !TO_LOADER_SET.has(to.loader)) {
      errors.push(`${at}: to.loader must be one of ${[...TO_LOADERS].join(', ')}`);
    }
    if (!isNonEmptyString(e.kind) || !KIND_SET.has(e.kind)) {
      errors.push(`${at}: kind must be one of ${[...EQUIVALENCE_KINDS].join(', ')}`);
    }
    if (e.kind !== 'missing' && !isNonEmptyString(to.api)) {
      errors.push(`${at}: to.api is required unless kind is "missing"`);
    }
    if (!Array.isArray(e.sources) || e.sources.length === 0) {
      errors.push(`${at}: sources[] must be non-empty`);
    } else {
      e.sources.forEach((s, si) => {
        if (!isNonEmptyString(s?.url)) errors.push(`${at}.sources[${si}]: url required`);
        if (!isNonEmptyString(s?.license)) errors.push(`${at}.sources[${si}]: license required`);
        if (isNonEmptyString(s?.license) && isLgplFamily(s.license)) {
          errors.push(`${at}.sources[${si}]: LGPL-family sources may not be quoted (§6.3)`);
        }
      });
    }
    if (e.caveats !== undefined && !isStringArray(e.caveats)) {
      errors.push(`${at}: caveats must be an array of strings`);
    }
    if (e.related !== undefined) {
      if (!isStringArray(e.related)) {
        errors.push(`${at}: related must be an array of strings`);
      } else {
        e.related.forEach((r, ri) => {
          if (!isBlessedRelated(r)) errors.push(`${at}.related[${ri}]: unrecognised scheme "${r}"`);
        });
      }
    }

    // Only compile a well-formed entry (the required scalar fields are present).
    if (
      isNonEmptyString(from.vocab) &&
      isNonEmptyString(from.api) &&
      isNonEmptyString(to.loader) &&
      isNonEmptyString(e.kind)
    ) {
      const fromApiAlt = isStringArray(from.api_alt) ? from.api_alt : [];
      const toApi =
        e.kind === 'missing' ? (isNonEmptyString(to.api) ? to.api : null) : (to.api ?? null);
      const compiled: CompiledEquivalenceEntry = {
        entry_key: deriveEntryKey(topic, from.vocab, from.api),
        topic,
        from_vocab: from.vocab,
        from_era: isNonEmptyString(from.era) ? from.era : null,
        from_api: from.api,
        from_api_alt: fromApiAlt,
        from_versions: isNonEmptyString(from.versions) ? from.versions : null,
        to_loader: to.loader,
        to_api: toApi,
        kind: e.kind,
        notes: isNonEmptyString(e.notes) ? e.notes : null,
        code_before: isNonEmptyString(e.code_before) ? e.code_before : null,
        code_after: isNonEmptyString(e.code_after) ? e.code_after : null,
        caveats: isStringArray(e.caveats) ? e.caveats : [],
        related: isStringArray(e.related) ? e.related : [],
        keywords: [],
        sources: Array.isArray(e.sources) ? e.sources : [],
        validated_against: isNonEmptyString(e.validated_against) ? e.validated_against : null,
      };
      compiled.keywords = deriveKeywords(compiled);
      entries.push(compiled);
    }
  });

  return { errors, entries };
}

/**
 * Cross-file invariants over the full compiled corpus:
 *  - entry_key uniqueness
 *  - internal related links (cleanroom://equivalence/<key> AND bare entry_keys) resolve
 */
export function crossValidate(entries: CompiledEquivalenceEntry[]): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const e of entries) {
    if (keys.has(e.entry_key)) {
      errors.push(`duplicate entry_key: ${e.entry_key}`);
    }
    keys.add(e.entry_key);
  }
  for (const e of entries) {
    for (const r of e.related) {
      // Resolve internal pointers: the cleanroom://equivalence/ scheme AND bare entry_keys.
      // External schemes (cleanroom://guide, cleanroom://template, api://) are not entries.
      let target: string | null = null;
      if (r.startsWith('cleanroom://equivalence/')) {
        target = r.slice('cleanroom://equivalence/'.length).split('#')[0]!;
      } else if (!r.startsWith('cleanroom://') && !r.startsWith('api://')) {
        target = r.split('#')[0]!;
      }
      if (target !== null && !keys.has(target)) {
        errors.push(`${e.entry_key}: related link does not resolve: ${r}`);
      }
    }
  }
  return errors;
}
