#!/usr/bin/env tsx
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable no-undef */
/**
 * Advanced documentation indexing script with full feature support
 * - Sitemap-based URL discovery
 * - Semantic search embeddings
 * - Version-aware indexing
 * - Incremental updates
 */

import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { DocumentCrawler, getFabricDocumentationUrls } from '../src/indexer/crawler.js';
import { DocumentChunker } from '../src/indexer/chunker.js';
import { DocumentStore } from '../src/indexer/store.js';
import { DBS } from '../src/dbs.js';
import { LOADERS, LOADER_IDS, isLoader, type Loader } from '../src/loaders.js';
import {
  getFabricUrlsFromSitemap,
  getFabricWikiUrlsFromSitemap,
  getForgeUrlsFromSitemap,
  getNeoforgeUrlsFromSitemap,
} from '../src/indexer/sitemap.js';
import {
  getCleanroomWikiPages,
  getCleanroomWikiFallbackUrls,
} from '../src/indexer/cleanroom-wiki.js';
import { EmbeddingGenerator } from '../src/indexer/embeddings.js';
import type { DocumentPage } from '../src/indexer/types.js';
import { compileEquivalence } from './equivalence-compile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface IndexOptions {
  force?: boolean;
  incremental?: boolean;
  useSitemap?: boolean;
  generateEmbeddings?: boolean;
  embeddingsBatchSize?: number;
  loaders?: Loader[];
  /** Compile data/equivalence/*.yaml into the equivalence table (default true). */
  equivalence?: boolean;
}

/** Loaders that have documentation sources registered (excludes 'shared'). */
const INDEXABLE_LOADERS: Loader[] = LOADER_IDS.filter((id) => LOADERS[id].sources.length > 0);

/**
 * Discover crawl URLs and/or pre-built pages for one loader.
 *
 * The target corpus (cleanroom/forge) is always discovered through the
 * sources registered in src/loaders.ts; the legacy --sitemap flag keeps its
 * historical meaning for the reference corpus only (sitemap discovery vs the
 * static Fabric URL list).
 */
async function discoverForLoader(
  loader: Loader,
  useSitemap: boolean
): Promise<{ urls: string[]; pages: DocumentPage[] }> {
  switch (loader) {
    case 'fabric': {
      if (!useSitemap) {
        return { urls: getFabricDocumentationUrls(), pages: [] };
      }
      const urls = [
        ...(await getFabricWikiUrlsFromSitemap()),
        ...(await getFabricUrlsFromSitemap()),
      ];
      if (urls.length === 0) {
        // Only Fabric's own failure may trigger the static Fabric fallback —
        // it must never fire during a run that didn't select fabric.
        console.log('⚠️  Fabric sitemap fetch failed, falling back to static list');
        return { urls: getFabricDocumentationUrls(), pages: [] };
      }
      return { urls, pages: [] };
    }
    case 'neoforge':
      return { urls: useSitemap ? await getNeoforgeUrlsFromSitemap() : [], pages: [] };
    case 'forge':
      return { urls: await getForgeUrlsFromSitemap(), pages: [] };
    case 'cleanroom': {
      try {
        return { urls: [], pages: await getCleanroomWikiPages() };
      } catch (error) {
        console.log(`⚠️  Cleanroom repo-markdown ingest failed (${String(error)});`);
        console.log('    falling back to crawling the live wiki via hashmap.json');
        return { urls: await getCleanroomWikiFallbackUrls(), pages: [] };
      }
    }
    case 'shared':
      return { urls: [], pages: [] };
  }
}

/**
 * Calculate optimal batch size based on system resources
 */
function calculateOptimalBatchSize(): number {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus().length;

  console.log('🖥️  System Resources:');
  console.log(`  • CPU Cores: ${cpus}`);
  console.log(`  • Total Memory: ${(totalMem / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`  • Free Memory: ${(freeMem / 1024 / 1024 / 1024).toFixed(2)} GB`);

  // Base batch size
  let batchSize = 20;

  // Adjust based on memory (conservative: 100MB per batch of embeddings approx)
  // If we have > 8GB free, we can go big
  if (freeMem > 8 * 1024 * 1024 * 1024) {
    batchSize = 100;
  } else if (freeMem > 4 * 1024 * 1024 * 1024) {
    batchSize = 50;
  } else if (freeMem > 2 * 1024 * 1024 * 1024) {
    batchSize = 30;
  } else {
    batchSize = 10; // Low memory mode
  }

  // Adjust based on CPU (more cores = can handle more parallel processing if we were parallelizing)
  // For embeddings, batch size also affects inference speed.
  // MiniLM is small, so we can increase batch size on better CPUs.
  if (cpus >= 16) {
    batchSize = Math.min(batchSize * 2, 200);
  } else if (cpus >= 8) {
    batchSize = Math.min(batchSize * 1.5, 150);
  }

  console.log(`⚡ Optimized Batch Size: ${Math.floor(batchSize)}`);
  return Math.floor(batchSize);
}

async function main(options: IndexOptions = {}) {
  console.log('🚀 Starting Advanced Documentation Indexing...\n');

  // Ensure data directory exists
  const dataDir = join(__dirname, '..', 'data');
  await mkdir(dataDir, { recursive: true });

  const dbPath = join(dataDir, DBS.docs.fileName);
  const store = new DocumentStore(dbPath);

  try {
    // Compile the equivalence corpus into its dedicated table (Phase 4).
    // Independent of the crawl; runs unless explicitly disabled with --no-equivalence.
    if (options.equivalence !== false) {
      const equivDir = join(dataDir, 'equivalence');
      const { entries, errors, fileCount } = await compileEquivalence(equivDir);
      if (errors.length > 0) {
        console.error(`❌ Equivalence corpus has ${errors.length} validation error(s):`);
        for (const e of errors) console.error(`   - ${e}`);
        throw new Error('Equivalence corpus validation failed — aborting index build.');
      }
      store.replaceEquivalence(entries);
      console.log(
        `🔗 Compiled ${entries.length} equivalence entries from ${fileCount} topic file(s)\n`
      );
    }

    // Discover URLs / pre-built pages per selected loader
    const selectedLoaders = options.loaders ?? INDEXABLE_LOADERS;
    console.log(`📡 Discovering documentation for: ${selectedLoaders.join(', ')}`);

    const urls: string[] = [];
    const prebuiltPages: DocumentPage[] = [];
    for (const loader of selectedLoaders) {
      const discovered = await discoverForLoader(loader, options.useSitemap ?? false);
      console.log(
        `  • ${loader}: ${discovered.urls.length} URLs to crawl` +
          (discovered.pages.length > 0 ? `, ${discovered.pages.length} repo-markdown pages` : '')
      );
      urls.push(...discovered.urls);
      prebuiltPages.push(...discovered.pages);
    }

    console.log(`📋 Found ${urls.length + prebuiltPages.length} documentation pages to index\n`);

    // Initialize crawler with progress tracking
    const crawler = new DocumentCrawler({
      maxConcurrency: 3,
      delayMs: 1000,
      retryAttempts: 3,
    });

    crawler.setProgressCallback((progress) => {
      const percent = Math.round((progress.completed / progress.total) * 100);
      const eta = progress.estimatedTimeRemaining
        ? ` | ETA: ${Math.round(progress.estimatedTimeRemaining)}s`
        : '';

      process.stdout.write(
        `\r⏳ Progress: ${progress.completed}/${progress.total} (${percent}%) | Failed: ${progress.failed}${eta}  `
      );
    });

    // Crawl all pages, then merge in the pages built straight from markdown
    console.log('🕷️  Crawling documentation...');
    const documents = await crawler.crawlAll(urls);
    console.log(`\n✅ Successfully crawled ${documents.length} pages`);
    if (prebuiltPages.length > 0) {
      documents.push(...prebuiltPages);
      console.log(`📄 Added ${prebuiltPages.length} repo-markdown pages`);
    }
    console.log('');

    // Initialize chunker
    const chunker = new DocumentChunker({
      maxChunkSize: 1000,
      overlapSize: 100,
      preserveCodeBlocks: true,
    });

    // Process and store documents
    console.log('💾 Storing documents and creating search indexes...');
    let processedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let totalChunksToEmbed = 0;

    // Track chunks for embedding in batches
    let pendingChunks: Array<{ id: string; content: string; documentId: number }> = [];
    let embeddingGen: EmbeddingGenerator | null = null;

    // Initialize embedding generator early if needed
    if (options.generateEmbeddings) {
      embeddingGen = new EmbeddingGenerator();
      await embeddingGen.initialize();
    }

    // Calculate optimal batch size if not provided
    const embeddingBatchSize = options.embeddingsBatchSize || calculateOptimalBatchSize();

    // Helper function to process pending embeddings
    async function processEmbeddingBatch() {
      if (!options.generateEmbeddings || pendingChunks.length === 0 || !embeddingGen) {
        return;
      }

      const batch = pendingChunks;
      pendingChunks = []; // Clear for next batch

      const batchTexts = batch.map((c) => c.content);
      // Pass the optimized batch size to the generator
      const batchEmbeddings = await embeddingGen.generateEmbeddings(batchTexts, embeddingBatchSize);

      const embeddings: Array<{ chunkId: string; embedding: number[] }> = [];
      for (let j = 0; j < batch.length; j++) {
        embeddings.push({
          chunkId: batch[j]!.id,
          embedding: batchEmbeddings[j]!,
        });
      }

      // Store embeddings immediately to free memory
      store.storeEmbeddings(embeddings, 'Xenova/all-MiniLM-L6-v2');

      // Clear arrays explicitly
      batchTexts.length = 0;
      embeddings.length = 0;

      // Force garbage collection hint aggressively
      if (global.gc) {
        global.gc();
      }

      // Yield to event loop
      await new Promise((resolve) => setImmediate(resolve));
    }

    for (const doc of documents) {
      try {
        // Check if document needs updating (incremental mode)
        if (options.incremental && !options.force) {
          if (!store.needsUpdate(doc.url, doc.hash)) {
            skippedCount++;
            continue;
          }
        }

        // Store document
        const documentId = store.storeDocument(doc);

        // Create and store chunks
        const chunks = chunker.chunkDocument(doc);
        store.storeChunks(chunks, documentId);

        // Collect chunks for embedding generation (but process in small batches)
        if (options.generateEmbeddings) {
          for (const chunk of chunks) {
            pendingChunks.push({
              id: chunk.id,
              content: chunk.content,
              documentId,
            });
            totalChunksToEmbed++;

            // Process embedding batch when size threshold reached
            if (pendingChunks.length >= embeddingBatchSize) {
              await processEmbeddingBatch();
            }
          }
        }

        updatedCount++;
        processedCount++;

        // Progress indicator
        process.stdout.write(
          `\r  Processed: ${processedCount}/${documents.length} | Updated: ${updatedCount} | Skipped: ${skippedCount}  `
        );
      } catch (error) {
        console.error(`\n❌ Error processing ${doc.url}:`, error);
      }
    }

    // Process remaining chunks
    if (pendingChunks.length > 0) {
      await processEmbeddingBatch();
    }

    console.log('\n');

    // Log embedding completion
    if (options.generateEmbeddings && totalChunksToEmbed > 0) {
      console.log(`✅ Embeddings generated and stored for ${totalChunksToEmbed} chunks\n`);
    }

    // Update timestamp
    store.updateTimestamp();

    // Stamp the schema version LAST — only a fully-built DB (equivalence compiled + crawl
    // stored) records schema_version=2, so an aborted rebuild-over-existing-file never leaves
    // a file that claims v2 while incomplete.
    store.stampSchemaVersion();

    // Show statistics
    console.log('📊 Indexing Statistics:');
    const stats = store.getStats();
    console.log(`  • Total Documents: ${stats.totalDocuments}`);
    console.log(`  • Total Sections: ${stats.totalSections}`);
    console.log(`  • Total Code Blocks: ${stats.totalCodeBlocks}`);
    for (const [loaderId, count] of Object.entries(stats.loaders)) {
      console.log(`  • ${loaderId}: ${count} docs`);
    }

    // Show version breakdown
    const versions = store.getAllVersions();
    if (versions.length > 0) {
      console.log(`  • Minecraft Versions: ${versions.join(', ')}`);
    }

    // Show embedding stats
    if (options.generateEmbeddings) {
      const embStats = store.getEmbeddingStats();
      console.log(`  • Total Embeddings: ${embStats.totalEmbeddings}`);
      if (embStats.models.length > 0) {
        console.log(
          `  • Embedding Models: ${embStats.models.map((m) => `${m.model} (${m.count})`).join(', ')}`
        );
      }
    }

    console.log(`  • Last Updated: ${stats.lastUpdated.toISOString()}`);
    console.log(`  • Index Version: ${stats.version}`);

    console.log(`\n✨ Indexing complete!`);
    console.log(`   Updated: ${updatedCount} documents`);
    console.log(`   Skipped: ${skippedCount} documents (no changes)`);
    console.log(`   Database: ${dbPath}\n`);
  } catch (error) {
    console.error('\n💥 Indexing failed:', error);
    process.exit(1);
  } finally {
    store.close();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

/** Parse --loaders a,b / --loaders=a,b into validated loader ids. */
function parseLoadersArg(argv: string[]): Loader[] | undefined {
  let raw: string | undefined;
  const eqForm = argv.find((a) => a.startsWith('--loaders='));
  if (eqForm) {
    raw = eqForm.slice('--loaders='.length);
  } else {
    const flagIndex = argv.indexOf('--loaders');
    if (flagIndex !== -1) {
      raw = argv[flagIndex + 1];
    }
  }
  if (raw === undefined) return undefined;

  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = ids.filter((id) => !isLoader(id));
  if (ids.length === 0 || invalid.length > 0) {
    console.error(`Invalid --loaders value "${raw}". Valid ids: ${INDEXABLE_LOADERS.join(', ')}`);
    process.exit(1);
  }
  return ids.filter(isLoader);
}

const options: IndexOptions = {
  force: args.includes('--force') || args.includes('-f'),
  incremental: args.includes('--incremental') || args.includes('-i'),
  useSitemap: args.includes('--sitemap') || args.includes('-s'),
  generateEmbeddings: args.includes('--embeddings') || args.includes('-e'),
  embeddingsBatchSize: 100,
  loaders: parseLoadersArg(args),
  equivalence: !args.includes('--no-equivalence'),
};

// Show help
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run index-docs [options]');
  console.log('');
  console.log('Options:');
  console.log('  -f, --force         Force full re-index (ignore hashes)');
  console.log('  -i, --incremental   Incremental update (skip unchanged)');
  console.log('  -s, --sitemap       Fetch reference-corpus URLs from sitemap.xml');
  console.log('  -e, --embeddings    Generate semantic embeddings');
  console.log('      --loaders a,b   Only index the given loaders');
  console.log(`                      (default: ${INDEXABLE_LOADERS.join(',')})`);
  console.log('      --no-equivalence  Skip compiling data/equivalence/*.yaml');
  console.log('  -h, --help          Show this help message');
  console.log('');
  console.log('Examples:');
  console.log('  npm run index-docs                          # Standard index');
  console.log('  npm run index-docs -- --incremental         # Update only changed pages');
  console.log('  npm run index-docs -- --sitemap             # Use sitemap for URLs');
  console.log('  npm run index-docs -- --embeddings          # Generate embeddings');
  console.log('  npm run index-docs -- -i -s -e              # All features');
  console.log('  npm run index-docs -- -s -e --loaders cleanroom,forge   # Target corpus only');
  process.exit(0);
}

// Run indexer
console.log('Configuration:');
console.log(`  • Force re-index: ${options.force ? 'Yes' : 'No'}`);
console.log(`  • Incremental: ${options.incremental ? 'Yes' : 'No'}`);
console.log(`  • Use sitemap: ${options.useSitemap ? 'Yes' : 'No'}`);
console.log(`  • Generate embeddings: ${options.generateEmbeddings ? 'Yes' : 'No'}`);
console.log(`  • Loaders: ${(options.loaders ?? INDEXABLE_LOADERS).join(', ')}`);
console.log(`  • Compile equivalence: ${options.equivalence !== false ? 'Yes' : 'No'}`);
console.log('');

main(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
