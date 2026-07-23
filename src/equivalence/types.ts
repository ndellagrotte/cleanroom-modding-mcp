/**
 * Shared types for the Phase 4 equivalence corpus.
 *
 * These describe the compiled form of a `data/equivalence/*.yaml` entry as it is
 * stored in the dedicated `equivalence` table inside docs.db (DESIGN §5.1). The
 * YAML authoring shape (nested `from`/`to`) is flattened at compile time in
 * scripts/equivalence-compile.ts; nothing under dist/ ever parses YAML.
 */

/** The three source vocabularies find_equivalent accepts. NOT Loader values (Fixed Input 3). */
export const FROM_VOCABS = ['fabric', 'neoforge', 'modern-minecraft'] as const;
export type FromVocab = (typeof FROM_VOCABS)[number];

/** The two porting targets. */
export const TO_LOADERS = ['cleanroom', 'forge'] as const;
export type ToLoader = (typeof TO_LOADERS)[number];

/** Equivalence kinds. Mirrored by the DB CHECK constraint. */
export const EQUIVALENCE_KINDS = ['direct', 'analog', 'pattern-change', 'missing'] as const;
export type EquivalenceKind = (typeof EQUIVALENCE_KINDS)[number];

/** Source-era tags (DESIGN §3.3). */
export const FROM_ERAS = [
  'yarn-<=1.21.11',
  'mojang-26x',
  'fabric-pre-1.20.5',
  'legacy-modern-forge-1.16-1.20.1',
] as const;
export type FromEra = (typeof FROM_ERAS)[number];

/** Citation + attribution for a single entry (DESIGN §6). */
export interface EquivalenceSource {
  url: string;
  license: string;
  quote?: string;
}

/**
 * A fully compiled equivalence entry, ready to bulk-insert.
 * Array fields are serialised to JSON TEXT columns at insert time.
 */
export interface CompiledEquivalenceEntry {
  entry_key: string;
  topic: string;
  from_vocab: string;
  from_era: string | null;
  from_api: string;
  from_api_alt: string[];
  from_versions: string | null;
  to_loader: string;
  to_api: string | null;
  kind: string;
  notes: string | null;
  code_before: string | null;
  code_after: string | null;
  caveats: string[];
  related: string[];
  keywords: string[];
  sources: EquivalenceSource[];
  validated_against: string | null;
}

/**
 * A parsed equivalence row as returned by the service (JSON columns decoded).
 */
export interface EquivalenceMatch {
  entryKey: string;
  topic: string;
  fromVocab: string;
  fromEra: string | null;
  fromApi: string;
  fromApiAlt: string[];
  fromVersions: string | null;
  toLoader: string;
  toApi: string | null;
  kind: string;
  notes: string | null;
  codeBefore: string | null;
  codeAfter: string | null;
  caveats: string[];
  related: string[];
  sources: EquivalenceSource[];
  validatedAgainst: string | null;
}
