/**
 * Example Service - Intelligent code example retrieval for AI
 * Uses multi-strategy search with query expansion and relevance scoring
 */

import { DocumentStore } from '../indexer/store.js';
import type { DocCoverageRow } from '../indexer/store.js';
import { EmbeddingGenerator } from '../indexer/embeddings.js';
import {
  pickLatestVersion,
  summarizeCoverage,
  type CoverageFilter,
  type DocCoverage,
} from './corpus-coverage.js';
import {
  tokenizeQuery,
  calculateRelevanceScore,
  deduplicateAndRank,
  languageMatches,
  type TokenizedQuery,
  type ScoredResult,
} from './search-utils.js';
import { getDefaultDbPath } from '../data-dir.js';
import { DBS } from '../dbs.js';
import { LOADER_IDS, scopeToLoaders, TARGET_VERSION, type Scope } from '../loaders.js';
import { DOC_CATEGORIES } from '../categories.js';

// Singleton instance for the embedding generator
let embeddingGeneratorInstance: EmbeddingGenerator | null = null;

async function getEmbeddingGenerator(): Promise<EmbeddingGenerator> {
  if (!embeddingGeneratorInstance) {
    embeddingGeneratorInstance = new EmbeddingGenerator();
    await embeddingGeneratorInstance.initialize();
  }
  return embeddingGeneratorInstance;
}

export interface CodeExample {
  code: string;
  language: string;
  description: string;
  relevanceScore: number;
  matchReasons: string[];
  context: {
    sectionHeading: string;
    sectionContent: string;
    documentTitle: string;
    documentUrl: string;
    category: string;
  };
  metadata: {
    loader: string;
    minecraftVersion: string | null;
    caption?: string;
  };
}

export interface ExampleSearchOptions {
  topic: string;
  language?: string;
  minecraftVersion?: string;
  /** Explicit loader filter — overrides `scope` when set. */
  loader?: string;
  /** Loader-family filter: 'target' (cleanroom/forge), 'reference' (fabric/neoforge), or 'all'. */
  scope?: Scope;
  category?: string;
  limit?: number;
}

interface CodeBlockResult {
  id: number;
  language: string;
  code: string;
  caption: string | null;
  section_heading: string;
  section_level: number;
  section_content: string;
  document_id: number;
  document_title: string;
  document_url: string;
  category: string;
  loader: string;
  minecraft_version: string | null;
}

/**
 * At most one snippet per source document in the first ranking pass. The docs corpus routinely
 * puts 4-6 code blocks on one page (Forge's items/loot_tables/ has 6 java blocks), and without a
 * cap that single page eats the caller's whole `limit`. Extras still backfill when distinct
 * documents cannot fill the request.
 */
const MAX_EXAMPLES_PER_DOCUMENT = 1;

/**
 * Relevance floor on the pooled score: a result must match the query somehow, not merely exist.
 *
 * `calculateRelevanceScore` awards a flat +10 for "has substantial code" (>50 chars) with zero
 * term matches, and `fallbackSearch` admits anything scoring >= 10 from an unfiltered scan. So
 * 10 is exactly the score of pure padding — before this floor existed, a nonsense query
 * returned a full page of results all scoring precisely 10.
 *
 * 20 was picked by measuring the corpus rather than by reasoning about the formula. Across
 * well-supported topics (register item, tile entity, mixin, block, gui, event handler,
 * capability, networking, loot table) the result count is identical at 15 and at 20, while the
 * 15-20 band contains only padding: it is the entire content of queries the corpus cannot
 * answer, such as "creative tab" (top score 16.3, no creative-tab content indexed at all).
 * Raising it further to 25 or 30 buys nothing and starts costing real hits.
 *
 * On the semantic side 20 corresponds to cosine >= 0.44, comfortably above the MiniLM baseline
 * where unrelated text pairs sit (the beta test was served a 0.358-similarity loot-table block,
 * score 8.297, as an answer).
 *
 * CAUTION: the lexical strategies (0-200+) and the semantic strategy (0-100) are pooled
 * un-normalized, and `searchViaCodePatterns` adds a flat +30. Re-derive this constant if those
 * scores are ever put on a common scale.
 */
const MIN_EXAMPLE_SCORE = 20;

export class ExampleService {
  private store: DocumentStore;

  /** Coverage rows, memoized — the corpus is read-only at runtime. */
  private coverageRows: DocCoverageRow[] | undefined;

  constructor(dbPath?: string) {
    const finalPath = dbPath || process.env.DB_PATH || getDefaultDbPath(DBS.docs.fileName);
    console.error(`[ExampleService] Using database at: ${finalPath}`);
    this.store = new DocumentStore(finalPath);
  }

  /**
   * Get code examples using intelligent multi-strategy search
   */
  async getExamples(options: ExampleSearchOptions): Promise<CodeExample[]> {
    const { topic, language, minecraftVersion, category, limit = 5 } = options;

    // Explicit loader wins; otherwise a scope expands to its loader set
    // ('all' or no scope = no filter).
    const loader: string | string[] | undefined =
      options.loader ??
      (options.scope && options.scope !== 'all' ? scopeToLoaders(options.scope) : undefined);

    console.error(`[ExampleService] Searching for: "${topic}"`);

    // Tokenize and expand query
    const query = tokenizeQuery(topic);
    console.error(`[ExampleService] Tokens: ${query.tokens.join(', ')}`);
    console.error(`[ExampleService] Expanded: ${query.expandedTokens.slice(0, 10).join(', ')}...`);
    console.error(`[ExampleService] FTS Query: ${query.ftsQuery}`);

    // Collect results from multiple strategies
    const allResults: ScoredResult<CodeBlockResult>[] = [];

    // Strategy 0: Semantic Search (Embeddings)
    try {
      const semanticResults = await this.searchViaEmbeddings(topic, {
        language,
        loader,
        minecraftVersion,
        category,
      });
      allResults.push(...semanticResults);
      console.error(`[ExampleService] Strategy 0 (semantic): ${semanticResults.length} results`);
    } catch (error) {
      console.error('[ExampleService] Semantic search failed (skipping):', error);
    }

    // Strategy 1: Search chunks with FTS/LIKE fallback, then get code blocks
    const chunkResults = this.searchViaChunks(query, {
      language,
      minecraftVersion,
      loader,
      category,
    });
    allResults.push(...chunkResults);
    console.error(`[ExampleService] Strategy 1 (chunks): ${chunkResults.length} results`);

    // Strategy 2: Direct code pattern search
    if (query.codePatterns.length > 0) {
      const codeResults = this.searchViaCodePatterns(query, {
        language,
        minecraftVersion,
        loader,
      });
      allResults.push(...codeResults);
      console.error(`[ExampleService] Strategy 2 (code patterns): ${codeResults.length} results`);
    }

    // Strategy 3: Document title/content search for related documents
    const docResults = this.searchViaDocuments(query, {
      language,
      minecraftVersion,
      loader,
      category,
    });
    allResults.push(...docResults);
    console.error(`[ExampleService] Strategy 3 (documents): ${docResults.length} results`);

    // Strategy 4: Fallback - get all code blocks and score them
    if (allResults.length < limit) {
      const fallbackResults = this.fallbackSearch(query, {
        language,
        minecraftVersion,
        loader,
        limit: limit * 3,
      });
      allResults.push(...fallbackResults);
      console.error(`[ExampleService] Strategy 4 (fallback): ${fallbackResults.length} results`);
    }

    // Deduplicate, apply the relevance floor, and enforce per-document diversity
    const ranked = deduplicateAndRank(allResults, limit, {
      minScore: MIN_EXAMPLE_SCORE,
      maxPerDocument: MAX_EXAMPLES_PER_DOCUMENT,
    });
    const bestScore = allResults.reduce((max, r) => Math.max(max, r.score), 0);
    console.error(
      `[ExampleService] After dedup/rank: ${ranked.length} results ` +
        `(pooled ${allResults.length}, best ${bestScore.toFixed(2)}, ` +
        `floor ${MIN_EXAMPLE_SCORE}, max ${MAX_EXAMPLES_PER_DOCUMENT}/document)`
    );

    // Convert to CodeExample format
    const examples = ranked.map((r) => this.toCodeExample(r.item, r.score, r.matchReasons));

    return examples;
  }

  /**
   * Resolve "latest" family-scoped: within the target family it is always the
   * fixed 1.12.2; within reference (or unscoped) it is derived from the
   * indexed data — never a hardcoded modern version.
   */
  getLatestMinecraftVersion(scope: Scope = 'target'): string {
    if (scope === 'target') {
      return TARGET_VERSION;
    }
    // Scope-filtered and Minecraft-shaped. `minecraft_version` also stores
    // loader versions ('26.2', '21.9'), and the previous numeric max picked one
    // of those — a "latest" that matched almost no document.
    const { versions } = this.getCoverage({ scope });
    console.error(`[ExampleService] Versions in scope ${scope}: ${versions.join(', ')}`);
    return pickLatestVersion(versions) ?? TARGET_VERSION;
  }

  /**
   * What a scope/category/version combination can reach in the docs corpus.
   *
   * Same projection `SearchService.getCoverage` uses; both go through
   * `summarizeCoverage` so the two documentation tools cannot report different
   * sizes for the same corpus.
   */
  getCoverage(filter: CoverageFilter): DocCoverage {
    if (!this.coverageRows) {
      this.coverageRows = this.store.getCoverage();
    }
    return summarizeCoverage(this.coverageRows, filter);
  }

  /**
   * Strategy 0: Semantic Search using Embeddings
   */
  private async searchViaEmbeddings(
    topic: string,
    options: {
      language?: string;
      loader?: string | string[];
      minecraftVersion?: string;
      category?: string;
    }
  ): Promise<ScoredResult<CodeBlockResult>[]> {
    const generator = await getEmbeddingGenerator();
    const embedding = await generator.generateEmbedding(topic);

    // Find similar chunks (text or code)
    // We ask for more results because we'll filter for code blocks later
    const similarChunks = this.store.findSimilarChunks(embedding, {
      limit: 20,
      loader: options.loader,
      minecraftVersion: options.minecraftVersion,
      category: options.category,
    });

    const results: ScoredResult<CodeBlockResult>[] = [];
    const processedDocIds = new Set<number>();

    for (const chunk of similarChunks) {
      // Avoid processing the same document multiple times from different chunks
      if (processedDocIds.has(chunk.document_id)) continue;
      processedDocIds.add(chunk.document_id);

      // Get all code blocks for the document of the similar chunk
      const codeBlocks = this.store.getCodeBlocksForDocument(chunk.document_id);

      for (const block of codeBlocks) {
        // The same language gate the lexical strategies apply. Without it, a semantically near
        // document contributes its JSON/text blocks to a `java` query.
        if (!languageMatches(block.language, options.language)) continue;

        // Calculate a score based on semantic similarity of the parent chunk
        // We use the similarity score from the embedding search

        let score = chunk.similarity || 0; // similarity is 0-1 (cosine)

        // Boost if the code block is in the same section as the matched text chunk
        if (block.section_heading === chunk.section_heading) {
          score *= 1.2;
        }

        // Normalize to our 0-100 scale (cosine is -1 to 1, but usually 0-1 for text)
        // Let's assume 0.7 is a good match.
        // We map 0.5-1.0 to 50-100.
        const normalizedScore = Math.max(0, (score - 0.3) * (100 / 0.7));

        results.push({
          item: {
            id: block.id,
            language: block.language,
            code: block.code,
            caption: block.caption,
            section_heading: block.section_heading,
            section_level: block.section_level,
            section_content: block.section_content,
            document_id: block.document_id,
            document_title: block.document_title,
            document_url: block.document_url,
            category: block.category,
            loader: block.loader,
            minecraft_version: block.minecraft_version,
          },
          score: normalizedScore,
          matchReasons: [
            `Semantic match with "${chunk.section_heading}" (${(score * 100).toFixed(0)}%)`,
          ],
        });
      }
    }

    return results;
  }

  /**
   * Strategy 1: Search via chunks (FTS + LIKE fallback)
   */
  private searchViaChunks(
    query: TokenizedQuery,
    options: {
      language?: string;
      minecraftVersion?: string;
      loader?: string | string[];
      category?: string;
    }
  ): ScoredResult<CodeBlockResult>[] {
    const results: ScoredResult<CodeBlockResult>[] = [];

    // Search chunks
    const chunks = this.store.searchChunksAdvanced(query.ftsQuery, query.likePatterns, {
      hasCode: true,
      language: options.language,
      loader: options.loader,
      minecraftVersion: options.minecraftVersion,
      category: options.category,
      limit: 100,
    });

    // Get code blocks for each matching chunk's document
    const seenDocIds = new Set<number>();

    for (const chunk of chunks) {
      if (seenDocIds.has(chunk.document_id)) continue;
      seenDocIds.add(chunk.document_id);

      const codeBlocks = this.store.getCodeBlocksWithContext(chunk.document_id);

      for (const block of codeBlocks) {
        // Filter by language if specified
        if (!languageMatches(block.language, options.language)) continue;

        const { score, reasons } = calculateRelevanceScore(
          {
            title: block.document_title,
            section_heading: block.section_heading,
            section_content: block.section_content,
            code: block.code,
            caption: block.caption,
            category: block.category,
            url: block.document_url,
          },
          query
        );

        if (score > 0) {
          results.push({
            item: block,
            score,
            matchReasons: reasons,
          });
        }
      }
    }

    return results;
  }

  /**
   * Strategy 2: Search via code patterns
   */
  private searchViaCodePatterns(
    query: TokenizedQuery,
    options: {
      language?: string;
      minecraftVersion?: string;
      loader?: string | string[];
    }
  ): ScoredResult<CodeBlockResult>[] {
    const results: ScoredResult<CodeBlockResult>[] = [];

    const codeBlocks = this.store.searchCodeBlocksByPatterns(query.codePatterns, {
      language: options.language,
      loader: options.loader,
      minecraftVersion: options.minecraftVersion,
      limit: 50,
    });

    for (const block of codeBlocks) {
      const { score, reasons } = calculateRelevanceScore(
        {
          title: block.document_title,
          section_heading: block.section_heading,
          section_content: block.section_content,
          code: block.code,
          caption: block.caption,
          category: block.category,
          url: block.document_url,
        },
        query
      );

      // Boost score for code pattern matches
      const boostedScore = score + 30;

      results.push({
        item: block,
        score: boostedScore,
        matchReasons: [...reasons, 'code pattern match'],
      });
    }

    return results;
  }

  /**
   * Strategy 3: Search via document title/content
   */
  private searchViaDocuments(
    query: TokenizedQuery,
    options: {
      language?: string;
      minecraftVersion?: string;
      loader?: string | string[];
      category?: string;
    }
  ): ScoredResult<CodeBlockResult>[] {
    const results: ScoredResult<CodeBlockResult>[] = [];

    const docs = this.store.searchDocumentsLike(query.likePatterns, {
      loader: options.loader,
      minecraftVersion: options.minecraftVersion,
      category: options.category,
      limit: 15,
    });

    for (const doc of docs) {
      const codeBlocks = this.store.getCodeBlocksWithContext(doc.id);

      for (const block of codeBlocks) {
        // Filter by language if specified
        if (!languageMatches(block.language, options.language)) continue;

        const { score, reasons } = calculateRelevanceScore(
          {
            title: block.document_title,
            section_heading: block.section_heading,
            section_content: block.section_content,
            code: block.code,
            caption: block.caption,
            category: block.category,
            url: block.document_url,
          },
          query
        );

        if (score > 0) {
          results.push({
            item: block,
            score,
            matchReasons: reasons,
          });
        }
      }
    }

    return results;
  }

  /**
   * Strategy 4: Fallback - get all code blocks and score them client-side
   */
  private fallbackSearch(
    query: TokenizedQuery,
    options: {
      language?: string;
      minecraftVersion?: string;
      loader?: string | string[];
      limit?: number;
    }
  ): ScoredResult<CodeBlockResult>[] {
    const results: ScoredResult<CodeBlockResult>[] = [];

    const codeBlocks = this.store.getAllCodeBlocksWithContext({
      language: options.language,
      loader: options.loader,
      minecraftVersion: options.minecraftVersion,
      limit: options.limit || 100,
    });

    for (const block of codeBlocks) {
      const { score, reasons } = calculateRelevanceScore(
        {
          title: block.document_title,
          section_heading: block.section_heading,
          section_content: block.section_content,
          code: block.code,
          caption: block.caption,
          category: block.category,
          url: block.document_url,
        },
        query
      );

      // Only include if score is above minimum threshold
      if (score >= 10) {
        results.push({
          item: block,
          score,
          matchReasons: reasons,
        });
      }
    }

    return results;
  }

  /**
   * Convert a code block result to CodeExample format
   */
  private toCodeExample(
    block: CodeBlockResult,
    score: number,
    matchReasons: string[]
  ): CodeExample {
    return {
      code: block.code,
      language: block.language,
      description: this.generateDescription(block),
      relevanceScore: score,
      matchReasons,
      context: {
        sectionHeading: block.section_heading,
        sectionContent: this.truncateContent(block.section_content, 500),
        documentTitle: block.document_title,
        documentUrl: block.document_url,
        category: block.category,
      },
      metadata: {
        loader: block.loader,
        minecraftVersion: block.minecraft_version,
        caption: block.caption || undefined,
      },
    };
  }

  /**
   * Generate a description for a code block
   */
  private generateDescription(block: CodeBlockResult): string {
    if (block.caption) {
      return block.caption;
    }

    // Try to extract first meaningful sentence from section content
    const sentences = block.section_content.split(/[.!?]+/);
    if (sentences.length > 0 && sentences[0] && sentences[0].trim().length > 10) {
      const firstSentence = sentences[0].trim();
      if (firstSentence.length <= 200) {
        return firstSentence;
      }
      return firstSentence.substring(0, 197) + '...';
    }

    return `Code example from "${block.section_heading}" in ${block.document_title}`;
  }

  /**
   * Truncate content intelligently at sentence boundaries
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }

    const truncated = content.substring(0, maxLength);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastQuestion = truncated.lastIndexOf('?');
    const lastExclamation = truncated.lastIndexOf('!');

    const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclamation);

    if (lastSentenceEnd > maxLength * 0.7) {
      return truncated.substring(0, lastSentenceEnd + 1);
    }

    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.8) {
      return truncated.substring(0, lastSpace) + '...';
    }

    return truncated + '...';
  }

  /**
   * Get available example topics based on indexed content
   */
  getAvailableTopics(): {
    categories: string[];
    languages: Array<{ language: string; count: number }>;
    loaders: string[];
    versions: string[];
  } {
    const languages = this.store.getAvailableLanguages();
    const versions = this.store.getAllVersions();

    return {
      categories: [...DOC_CATEGORIES],
      languages,
      loaders: LOADER_IDS,
      versions,
    };
  }

  /**
   * Format examples for AI-friendly output
   */
  formatForAI(examples: CodeExample[]): string {
    if (examples.length === 0) {
      return 'No code examples found for the specified criteria.';
    }

    let output = `Found ${examples.length} relevant code example${examples.length > 1 ? 's' : ''} for minecraft version ${examples[0]?.metadata.minecraftVersion || 'unknown'}:\n\n`;

    for (let i = 0; i < examples.length; i++) {
      const example = examples[i];
      if (!example) continue;

      output += `## Example ${i + 1}: ${example.context.sectionHeading}\n\n`;

      if (example.description) {
        output += `**Description:** ${example.description}\n\n`;
      }

      output += `**Source:** ${example.context.documentTitle}\n`;
      output += `**Category:** ${example.context.category}\n`;
      output += `**Loader:** ${example.metadata.loader}\n`;

      if (example.metadata.minecraftVersion) {
        output += `**Minecraft Version:** ${example.metadata.minecraftVersion}\n`;
      }

      output += `**URL:** ${example.context.documentUrl}\n`;
      output += `**Relevance:** ${example.relevanceScore} (${example.matchReasons.slice(0, 3).join(', ')})\n\n`;

      output += `\`\`\`${example.language}\n${example.code}\n\`\`\`\n\n`;

      if (example.context.sectionContent && example.context.sectionContent.length > 50) {
        output += `**Context:**\n${example.context.sectionContent}\n\n`;
      }

      output += '---\n\n';
    }

    return output;
  }

  /**
   * Close database connection
   */
  close() {
    this.store.close();
  }
}
