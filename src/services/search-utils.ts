/**
 * Search Utilities - Intelligent query processing for Minecraft modding documentation
 * Handles tokenization, synonyms, query expansion, and relevance scoring
 */

import { stripZeroWidth } from '../indexer/text.js';

/**
 * Common English stopwords to filter out
 */
const STOPWORDS = new Set([
  'how',
  'to',
  'in',
  'a',
  'an',
  'the',
  'for',
  'of',
  'with',
  'on',
  'at',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  'that',
  'this',
  'these',
  'those',
  'can',
  'do',
  'does',
  'did',
  'will',
  'would',
  'should',
  'could',
  'may',
  'might',
  'must',
]);

/**
 * High-frequency domain terms that should have lower weight
 */
const COMMON_TERMS = new Set([
  'cleanroom',
  'forge',
  'fabric',
  'neoforge',
  'minecraft',
  'mod',
  'loader',
  'java',
  'api',
  'version',
  'game',
  'server',
  'client',
]);

/**
 * Minecraft modding domain-specific synonyms and related terms
 */
const MINECRAFT_SYNONYMS: Record<string, string[]> = {
  // Registration patterns
  register: [
    'registration',
    'registering',
    'create',
    'add',
    'define',
    'declare',
    'init',
    'initialize',
  ],
  item: ['items', 'itemstack', 'tool', 'weapon', 'armor'],
  block: ['blocks', 'blockstate', 'tile'],
  entity: ['entities', 'mob', 'creature', 'living'],

  // Common actions
  create: ['make', 'build', 'generate', 'new', 'add', 'register'],
  custom: ['custom', 'modded', 'new', 'own'],
  add: ['adding', 'insert', 'include', 'register', 'create'],

  // Technical terms
  mixin: ['mixins', 'injection', 'inject', 'hook', 'patch'],
  event: ['events', 'listener', 'handler', 'callback', 'subscribe'],
  network: ['networking', 'packet', 'packets', 'sync', 'synchronize', 's2c', 'c2s'],
  render: ['rendering', 'renderer', 'draw', 'display', 'model', 'texture'],
  data: ['datagen', 'data-generation', 'datapack', 'json', 'recipe', 'loot'],

  // Fabric-specific
  fabric: ['fabricmc', 'fabric-api', 'fapi'],
  entrypoint: ['entrypoints', 'initializer', 'mod-initializer', 'main', 'client', 'server'],
  registry: ['registries', 'registered', 'identifier', 'id'],

  // Block types
  blockentity: ['block-entity', 'tile-entity', 'tileentity', 'be'],
  container: ['inventory', 'chest', 'storage', 'gui', 'screen', 'menu'],

  // Features
  recipe: ['recipes', 'crafting', 'smelting', 'cooking'],
  loot: ['loottable', 'loot-table', 'drops', 'drop'],
  tag: ['tags', 'tagging', 'itemtag', 'blocktag'],
  sound: ['sounds', 'audio', 'music', 'sfx'],
  particle: ['particles', 'effect', 'effects', 'fx'],

  // Commands
  command: ['commands', 'cmd', 'brigadier', 'argument'],
  keybind: ['keybinding', 'keybinds', 'key', 'hotkey', 'shortcut', 'input'],

  // World
  world: ['level', 'dimension', 'worldgen', 'generation', 'biome'],
  structure: ['structures', 'building', 'feature', 'worldgen'],
};

/**
 * Common Minecraft class/method patterns to help with code search
 */
const CODE_PATTERNS: Record<string, string[]> = {
  register: ['Registry.register', 'REGISTRY', 'Registries', 'RegistryKey'],
  item: ['Item', 'ItemStack', 'Item.Settings', 'FabricItemSettings'],
  block: ['Block', 'BlockState', 'Block.Settings', 'FabricBlockSettings'],
  entity: ['Entity', 'LivingEntity', 'EntityType', 'FabricEntityTypeBuilder'],
  blockentity: ['BlockEntity', 'BlockEntityType', 'FabricBlockEntityTypeBuilder'],
  mixin: ['@Mixin', '@Inject', '@Redirect', '@ModifyVariable', 'CallbackInfo'],
  event: ['Event', 'Callback', 'register()', 'ServerLifecycleEvents', 'ClientLifecycleEvents'],
  network: ['PacketByteBuf', 'ServerPlayNetworking', 'ClientPlayNetworking', 'PayloadTypeRegistry'],
  recipe: ['Recipe', 'RecipeSerializer', 'RecipeType', 'Ingredient'],
  command: ['CommandRegistrationCallback', 'LiteralArgumentBuilder', 'RequiredArgumentBuilder'],
  keybind: ['KeyBinding', 'KeyBindingHelper', 'GLFW'],
  screen: ['Screen', 'HandledScreen', 'ScreenHandler', 'ContainerScreen'],
  render: ['Renderer', 'RenderLayer', 'VertexConsumer', 'MatrixStack', 'DrawContext'],
};

export interface TokenizedQuery {
  original: string;
  tokens: string[];
  expandedTokens: string[];
  ftsQuery: string;
  likePatterns: string[];
  codePatterns: string[];
}

/**
 * Tokenize and preprocess a search query
 */
export function tokenizeQuery(query: string): TokenizedQuery {
  const original = query.trim();

  // Tokenize: split on whitespace and common separators
  const tokens = original
    .toLowerCase()
    .split(/[\s\-_.,;:!?()[\]{}'"]+/)
    .filter((t) => t.length > 1)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => !STOPWORDS.has(t)); // Filter stopwords

  // Expand tokens with synonyms
  const expandedSet = new Set<string>();

  for (const token of tokens) {
    expandedSet.add(token);

    // Add direct synonyms
    if (MINECRAFT_SYNONYMS[token]) {
      for (const syn of MINECRAFT_SYNONYMS[token]) {
        expandedSet.add(syn);
      }
    }

    // Check if token is a synonym of something else
    for (const [key, synonyms] of Object.entries(MINECRAFT_SYNONYMS)) {
      if (synonyms.includes(token)) {
        expandedSet.add(key);
        for (const syn of synonyms) {
          expandedSet.add(syn);
        }
      }
    }
  }

  const expandedTokens = Array.from(expandedSet);

  // Build FTS5 query with OR logic
  const ftsQuery = buildFtsQuery(tokens, expandedTokens);

  // Build LIKE patterns for fallback
  const likePatterns = buildLikePatterns(tokens);

  // Get relevant code patterns
  const codePatterns = getCodePatterns(tokens);

  return {
    original,
    tokens,
    expandedTokens,
    ftsQuery,
    likePatterns,
    codePatterns,
  };
}

/**
 * Build an FTS5 query with proper syntax
 * Uses OR for expanded terms, with original terms boosted
 */
function buildFtsQuery(tokens: string[], expandedTokens: string[]): string {
  if (tokens.length === 0) return '';

  // Simple approach: use OR between all expanded tokens
  // FTS5 will handle ranking based on term frequency
  const uniqueTerms = Array.from(new Set([...tokens, ...expandedTokens]));

  // Filter out very short terms and escape special characters
  const validTerms = uniqueTerms
    .filter((t) => t.length > 2)
    .map((t) => t.replace(/['"]/g, ''))
    .filter((t) => t.length > 0);

  if (validTerms.length === 0) {
    // Fallback: use original tokens even if short
    return tokens.map((t) => `"${t}"`).join(' OR ');
  }

  // Build query: original tokens get quoted (phrase-like), expanded get OR'd
  const parts: string[] = [];

  // Add original query as a phrase attempt (high relevance if matches)
  if (tokens.length > 1) {
    parts.push(`"${tokens.join(' ')}"`);
  }

  // Add individual tokens
  // Use AND for the first few important tokens to ensure relevance
  // But fallback to OR if we have many tokens to avoid zero results
  if (validTerms.length <= 3) {
    // For short queries, try to match ALL terms
    parts.push(validTerms.join(' AND '));
  } else {
    // For longer queries, use OR but rely on ranking
    parts.push(validTerms.join(' OR '));
  }

  return parts.join(' OR ');
}

/**
 * Build LIKE patterns for SQL fallback search
 */
function buildLikePatterns(tokens: string[]): string[] {
  const patterns: string[] = [];

  // Full phrase pattern
  if (tokens.length > 0) {
    patterns.push(`%${tokens.join('%')}%`);
  }

  // Individual token patterns
  for (const token of tokens) {
    if (token.length > 2) {
      patterns.push(`%${token}%`);
    }
  }

  return patterns;
}

/**
 * Get relevant code patterns based on query tokens
 */
function getCodePatterns(tokens: string[]): string[] {
  const patterns: string[] = [];

  for (const token of tokens) {
    if (CODE_PATTERNS[token]) {
      patterns.push(...CODE_PATTERNS[token]);
    }

    // Check synonyms too
    for (const [key, synonyms] of Object.entries(MINECRAFT_SYNONYMS)) {
      if (synonyms.includes(token) && CODE_PATTERNS[key]) {
        patterns.push(...CODE_PATTERNS[key]);
      }
    }
  }

  return Array.from(new Set(patterns));
}

export interface ScoredResult<T> {
  item: T;
  score: number;
  matchReasons: string[];
}

/**
 * Calculate relevance score for a search result
 */
export function calculateRelevanceScore(
  item: {
    title?: string;
    content?: string;
    section_heading?: string | null;
    section_content?: string;
    code?: string;
    caption?: string | null;
    category?: string;
    url?: string;
  },
  query: TokenizedQuery
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const titleLower = (item.title || '').toLowerCase();
  const headingLower = (item.section_heading || '').toLowerCase();
  const contentLower = (item.content || item.section_content || '').toLowerCase();
  const codeLower = (item.code || '').toLowerCase();
  const captionLower = (item.caption || '').toLowerCase();
  const categoryLower = (item.category || '').toLowerCase();
  const urlLower = (item.url || '').toLowerCase();

  // Exact phrase match (highest score)
  const originalLower = query.original.toLowerCase();
  if (titleLower.includes(originalLower)) {
    score += 100;
    reasons.push('exact phrase in title');
  }
  if (headingLower.includes(originalLower)) {
    score += 80;
    reasons.push('exact phrase in heading');
  }
  if (captionLower.includes(originalLower)) {
    score += 70;
    reasons.push('exact phrase in caption');
  }

  // Token matches in different fields
  for (const token of query.tokens) {
    if (token.length < 2) continue;

    // Determine weight based on term frequency
    const isCommon = COMMON_TERMS.has(token);
    const weightMultiplier = isCommon ? 0.1 : 1.0;

    // Title matches (high value)
    if (titleLower.includes(token)) {
      score += 20 * weightMultiplier;
      if (!reasons.includes('token in title')) reasons.push('token in title');
    }

    // Heading matches (high value)
    if (headingLower.includes(token)) {
      score += 18 * weightMultiplier;
      if (!reasons.includes('token in heading')) reasons.push('token in heading');
    }

    // Caption matches
    if (captionLower.includes(token)) {
      score += 15 * weightMultiplier;
      if (!reasons.includes('token in caption')) reasons.push('token in caption');
    }

    // URL/path matches (indicates topic relevance)
    if (urlLower.includes(token)) {
      score += 12 * weightMultiplier;
      if (!reasons.includes('token in URL')) reasons.push('token in URL');
    }

    // Category matches
    if (categoryLower.includes(token)) {
      score += 10 * weightMultiplier;
      if (!reasons.includes('token in category')) reasons.push('token in category');
    }

    // Content matches
    if (contentLower.includes(token)) {
      score += 5 * weightMultiplier;
      if (!reasons.includes('token in content')) reasons.push('token in content');
    }
  }

  // Code pattern matches
  for (const pattern of query.codePatterns) {
    if (codeLower.includes(pattern.toLowerCase())) {
      score += 25;
      if (!reasons.includes('code pattern match')) reasons.push('code pattern match');
    }
  }

  // Expanded token matches (lower weight)
  for (const token of query.expandedTokens) {
    if (query.tokens.includes(token)) continue; // Skip original tokens

    if (titleLower.includes(token) || headingLower.includes(token)) {
      score += 8;
      if (!reasons.includes('synonym match')) reasons.push('synonym match');
    }
  }

  // Boost for having code
  if (item.code && item.code.length > 50) {
    score += 10;
    reasons.push('has substantial code');
  }

  return { score, reasons };
}

/**
 * Language-filter comparison for code blocks. Deliberately case-insensitive: the docs corpus
 * carries `java`, `Java` and `JAVA` for the same language (forge alone has 32/19/10), so a
 * `!==` comparison silently hides roughly a third of one loader's Java snippets.
 */
export function languageMatches(
  blockLanguage: string | null | undefined,
  wanted?: string
): boolean {
  if (!wanted) return true;
  return (blockLanguage ?? '').toLowerCase() === wanted.toLowerCase();
}

/**
 * Identity of a documentation page independent of the version segment in its path:
 * /1.21.4/develop/blocks/first-block -> /develop/blocks/first-block. Shared by SearchService's
 * URL dedup and the example diversity cap so the same page indexed at two doc versions counts
 * as one document in both.
 */
export function urlPathKey(url: string): string {
  return url.replace(/\/\d+\.\d+(?:\.\d+)?\//, '/');
}

export interface DeduplicateOptions {
  /**
   * Relevance floor. Results scoring strictly below this are dropped before ranking.
   * NOTE: this applies to the POOLED, un-normalized scores — the lexical strategies run 0-200+
   * via calculateRelevanceScore while the semantic strategy runs 0-100 via
   * (cosine - 0.3) * (100/0.7). Re-derive this constant if the strategies are ever put on one
   * scale.
   */
  minScore?: number;
  /**
   * Diversity cap: at most this many results per source document in the first pass. Overflow is
   * NOT discarded — it backfills, in score order, only when distinct documents cannot fill
   * `limit`.
   */
  maxPerDocument?: number;
}

/** Marks a result that only made the cut because distinct documents ran out. */
export const BACKFILL_REASON = 'additional snippet from an already-listed page';

interface DeduplicableItem {
  code?: string;
  url?: string;
  document_url?: string;
  document_id?: number;
  section_heading?: string | null;
}

/** Exact-content key: identical code is one result regardless of where it came from. */
function contentKey(item: DeduplicableItem): string {
  if (item.code) {
    // Use first 200 chars of code as key
    return item.code.substring(0, 200).replace(/\s+/g, ' ');
  }
  // This previously read `item.url`, which code-block results never carry (they have
  // `document_url`), collapsing every code-less item to "::<heading>".
  return `${item.url ?? item.document_url ?? ''}::${item.section_heading ?? ''}`;
}

/** Source-document key for the diversity cap; '' means "no identity, do not cap". */
function documentKey(item: DeduplicableItem): string {
  const url = item.url ?? item.document_url;
  if (url) return urlPathKey(url);
  return item.document_id !== undefined ? `doc:${item.document_id}` : '';
}

/**
 * Deduplicate and rank results.
 *
 * With `maxPerDocument` set, the output is intentionally NOT in strict score order: a second
 * snippet from an already-represented page is held back and appended only if distinct pages
 * cannot fill `limit`. The cap never costs the caller results — it only reorders them.
 */
export function deduplicateAndRank<T extends DeduplicableItem>(
  results: ScoredResult<T>[],
  limit: number,
  options: DeduplicateOptions = {}
): ScoredResult<T>[] {
  const { minScore = 0, maxPerDocument } = options;

  // .filter() already copies, so the caller's array is never mutated by the sort
  const sorted = results
    .filter((result) => result.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const perDocument = new Map<string, number>();
  const primary: ScoredResult<T>[] = [];
  const overflow: ScoredResult<T>[] = [];

  for (const result of sorted) {
    const key = contentKey(result.item);
    if (seen.has(key)) continue;
    seen.add(key);

    const docKey = documentKey(result.item);
    const used = perDocument.get(docKey) ?? 0;
    if (maxPerDocument !== undefined && docKey !== '' && used >= maxPerDocument) {
      overflow.push(result);
      continue;
    }
    if (docKey !== '') perDocument.set(docKey, used + 1);

    primary.push(result);
    if (primary.length >= limit) return primary;
  }

  // Label the backfilled entries so a repeated page reads as "the corpus had nothing else"
  // rather than as breadth. Build new objects — never mutate the caller's results.
  const backfilled = overflow
    .slice(0, Math.max(0, limit - primary.length))
    .map((result) => ({ ...result, matchReasons: [...result.matchReasons, BACKFILL_REASON] }));

  return [...primary, ...backfilled];
}

/**
 * Text cleanup shared by every documentation renderer. Zero-width removal must
 * happen before whitespace collapse: otherwise an anchor artefact can keep two
 * visually identical passages distinct during deduplication.
 */
export function cleanDocumentationText(text: string): string {
  return stripZeroWidth(text)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface DocumentationSection {
  heading: string;
  content: string;
}

function normalizedContentKey(text: string): string {
  return cleanDocumentationText(text).toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Remove the heading copied into the start of a stored chunk. A section body
 * that is empty, shorter than its heading, or starts in the middle of a
 * sentence is not useful enough to render.
 */
export function meaningfulSectionBody(content: string, heading: string): string | null {
  const cleanedHeading = cleanDocumentationText(heading);
  let body = cleanDocumentationText(content);
  const firstBreak = body.indexOf('\n');

  if (
    cleanedHeading &&
    firstBreak >= 0 &&
    body.slice(0, firstBreak).trim().toLowerCase() === cleanedHeading.toLowerCase()
  ) {
    body = body.slice(firstBreak + 1).trim();
  }

  body = body.replace(/^#{1,6}\s+[^\n]+\n+/, '').trim();
  if (body.length < 20 || body.length <= cleanedHeading.length || /^[a-z]/.test(body)) {
    return null;
  }
  return body;
}

/**
 * Canonical section deduplication for search_docs and explain_concept.
 * One meaningful body per heading avoids rendering overlapping chunks as
 * repeated sections while still allowing a broken first chunk to be skipped.
 */
export function canonicalSections<T extends DocumentationSection>(
  sections: readonly T[],
  limit: number = Number.POSITIVE_INFINITY
): T[] {
  const seenHeadings = new Set<string>();
  const seenBodies = new Set<string>();
  const selected: T[] = [];

  for (const section of sections) {
    const body = meaningfulSectionBody(section.content, section.heading);
    if (!body) continue;

    const headingKey = normalizedContentKey(section.heading);
    const bodyKey = normalizedContentKey(body);
    if (seenHeadings.has(headingKey) || seenBodies.has(bodyKey)) continue;

    seenHeadings.add(headingKey);
    seenBodies.add(bodyKey);
    selected.push({ ...section, heading: cleanDocumentationText(section.heading), content: body });
    if (selected.length >= limit) break;
  }

  return selected;
}

/**
 * Bound prose without cutting a sentence, token, or word. The requested length
 * is soft only for a single token that crosses it; returning that token whole
 * is preferable to manufacturing a partial identifier.
 */
export function truncateAtBoundary(text: string, maxLength: number): string {
  const cleaned = cleanDocumentationText(text);
  if (cleaned.length <= maxLength) return cleaned;

  const window = cleaned.slice(0, maxLength + 1);
  let sentenceEnd = -1;
  const endings = /[.!?](?=\s|$)/g;
  for (const match of window.matchAll(endings)) {
    sentenceEnd = match.index + 1;
  }
  if (sentenceEnd >= maxLength * 0.45) {
    return cleaned.slice(0, sentenceEnd).trim();
  }

  const boundary = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
  if (boundary > 0) {
    return `${cleaned.slice(0, boundary).trimEnd()}...`;
  }

  const nextBoundary = cleaned.slice(maxLength).search(/\s/);
  if (nextBoundary >= 0) {
    return `${cleaned.slice(0, maxLength + nextBoundary).trimEnd()}...`;
  }
  return cleaned;
}

interface SummaryCandidate {
  text: string;
  matches: number;
  sourceOrder: number;
  sentenceOrder: number;
}

function summarySentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  const endings = /[.!?](?=\s|$)/g;
  for (const match of text.matchAll(endings)) {
    const end = match.index + 1;
    sentences.push(text.slice(start, end).trim());
    start = end;
  }
  if (start < text.length) sentences.push(text.slice(start).trim());

  return sentences.filter((sentence) => sentence.length >= 20 && !/^[a-z]/.test(sentence));
}

/**
 * Canonical summary selection. Sources are priority ordered; query terms break
 * that priority only when another complete sentence matches more of them.
 */
export function canonicalSummary(
  sources: readonly string[],
  terms: readonly string[],
  maxLength: number
): string {
  const normalizedTerms = terms.map((term) => term.toLowerCase()).filter((term) => term.length > 1);
  const candidates: SummaryCandidate[] = [];

  sources.forEach((source, sourceOrder) => {
    const cleaned = cleanDocumentationText(source);
    const firstLineEnd = cleaned.indexOf('\n');
    const firstLine =
      firstLineEnd > 0 && firstLineEnd < 120 ? cleaned.slice(0, firstLineEnd).trim() : '';
    const inferredHeading = firstLine && !/[.!?]$/.test(firstLine) ? firstLine : '';
    const body = inferredHeading
      ? meaningfulSectionBody(cleaned, inferredHeading)
      : cleaned.length >= 20 && !/^[a-z]/.test(cleaned)
        ? cleaned
        : null;
    if (!body) return;

    summarySentences(body).forEach((sentence, sentenceOrder) => {
      const lower = sentence.toLowerCase();
      candidates.push({
        text: sentence,
        matches: normalizedTerms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0),
        sourceOrder,
        sentenceOrder,
      });
    });
  });

  candidates.sort(
    (a, b) =>
      b.matches - a.matches || a.sourceOrder - b.sourceOrder || a.sentenceOrder - b.sentenceOrder
  );
  const best = candidates[0];
  return best ? truncateAtBoundary(best.text, maxLength) : '';
}

/** Normalize pooled internal relevance to the public 0-100 scale. */
export function normalizeScore(score: number, maxPossible: number = 200): number {
  const normalized = Math.max(0, Math.min(100, (score / maxPossible) * 100));
  return Math.round(normalized * 10) / 10;
}

/** Public numeric scores always use one decimal and the same percentage scale. */
export function formatPublicScore(score: number, maxPossible: number = 200): string {
  return `${normalizeScore(score, maxPossible).toFixed(1)}%`;
}

export function formatQualityScore(score: number): string {
  return `${(Math.max(0, Math.min(1, score)) * 100).toFixed(1)}%`;
}
