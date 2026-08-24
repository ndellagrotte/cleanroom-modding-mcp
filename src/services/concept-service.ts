/**
 * Concept Service - Intelligent concept explanation using hybrid search
 * Provides comprehensive explanations of Minecraft modding concepts
 * by aggregating information from multiple sources using FTS + semantic search
 */

import { DocumentStore } from '../indexer/store.js';
import { EmbeddingGenerator } from '../indexer/embeddings.js';
import {
  canonicalSections,
  canonicalSummary,
  cleanDocumentationText,
  tokenizeQuery,
} from './search-utils.js';
import { getDefaultDbPath } from '../data-dir.js';
import { DBS } from '../dbs.js';
import { LOADERS, perspectiveToLoaders, type Loader } from '../loaders.js';
import type { CONCEPT_CATEGORIES } from '../categories.js';
import { equivalenceRowToMatch } from './equivalence-service.js';
import type { EquivalenceMatch } from '../equivalence/types.js';

/**
 * Exact concept-id → corpus-topic map for cross-loader difference banners (DESIGN §4.3).
 *
 * This is an EXACT-KEY lookup only. It deliberately does NOT route through expandConcept's
 * bidirectional-substring aliasing (which over-matches — RESEARCH R7): a banner is attached
 * only when the requested concept id is a literal key here. Keys are normalized (lowercased)
 * concept ids as passed to explainConcept.
 */
// Keys are CANONICAL KNOWN_CONCEPTS ids (the ids getSuggestedConcepts advertises and users
// actually type). A few natural-language spellings are added for robustness. Do NOT rely on
// topic-slug spellings like 'events'/'mixins'/'registration' alone: explain_concept receives
// the canonical id ('event'/'mixin'/'registry'), so those would never fire on their own.
export const CONCEPT_TO_TOPIC: Record<string, string> = {
  // registration
  registry: 'registration',
  gameregistry: 'registration',
  registration: 'registration',
  // events
  event: 'events',
  events: 'events',
  // networking
  networking: 'networking',
  // mixins & access transformers
  mixin: 'mixins-access-transformers',
  mixins: 'mixins-access-transformers',
  mixinbooter: 'mixins-access-transformers',
  coremods: 'mixins-access-transformers',
  'access transformers': 'mixins-access-transformers',
  // capabilities
  capabilities: 'capabilities-attachments',
  // item/block settings
  item: 'item-block-settings',
  block: 'item-block-settings',
  creativetabs: 'item-block-settings',
  oredictionary: 'item-block-settings',
  // rendering
  render: 'block-entity-renderer',
};

/**
 * Concept explanation result
 */
export interface ConceptExplanation {
  concept: string;
  summary: string;
  details: string;
  keyPoints: string[];
  codeExamples: Array<{
    language: string;
    code: string;
    caption?: string;
    context: string;
    sourceUrl: string;
  }>;
  relatedConcepts: string[];
  resources: Array<{
    title: string;
    url: string;
    relevance: number;
  }>;
  /** Cross-loader difference rows, populated when the concept maps to a corpus topic (§4.3). */
  equivalence?: EquivalenceMatch[];
  metadata: {
    loader: Loader;
    sourcesUsed: number;
    hasEmbeddings: boolean;
    searchStrategy: string;
  };
}

/**
 * Internal chunk result with scoring
 */
interface ScoredChunk {
  id: string;
  content: string;
  sectionHeading: string | null;
  documentTitle: string;
  documentUrl: string;
  category: string;
  score: number;
  hasCode: boolean;
}

/**
 * Known Minecraft modding concepts with aliases and descriptions.
 * Aliases expand bidirectionally by substring (see expandConcept), so keep
 * them specific enough not to hijack unrelated concepts.
 */
const KNOWN_CONCEPTS: Record<
  string,
  { aliases: string[]; category: (typeof CONCEPT_CATEGORIES)[number] }
> = {
  mixin: {
    aliases: ['mixins', 'injection', 'inject', '@mixin', '@inject', 'bytecode modification'],
    category: 'coremods-mixins',
  },
  registry: {
    aliases: ['registries', 'registration', 'register', 'identifier', 'registry key'],
    category: 'registry',
  },
  entrypoint: {
    aliases: ['entrypoints', 'mod initializer', 'initializer', 'onInitialize', 'main class'],
    category: 'getting-started',
  },
  'fabric.mod.json': {
    aliases: ['mod json', 'mod metadata', 'mod manifest', 'mod config file'],
    category: 'getting-started',
  },
  'sided logic': {
    aliases: ['client side', 'server side', 'logical side', 'physical side', 'sided', 'isClient'],
    category: 'networking',
  },
  networking: {
    aliases: ['packets', 'payload', 'c2s', 's2c', 'sync', 'channel', 'network'],
    category: 'networking',
  },
  blockentity: {
    aliases: ['block entity', 'tile entity', 'tileentity', 'block with data'],
    category: 'tile-entities',
  },
  item: {
    aliases: ['items', 'itemstack', 'custom item', 'item settings'],
    category: 'items',
  },
  block: {
    aliases: ['blocks', 'block state', 'blockstate', 'custom block'],
    category: 'blocks',
  },
  event: {
    aliases: ['events', 'callback', 'listener', 'handler', 'subscribe'],
    category: 'events',
  },
  recipe: {
    aliases: ['recipes', 'crafting', 'smelting', 'recipe type', 'recipe serializer'],
    category: 'recipes',
  },
  datagen: {
    aliases: ['data generation', 'data gen', 'generators', 'provider'],
    category: 'resources',
  },
  render: {
    aliases: ['rendering', 'renderer', 'draw', 'model', 'texture', 'shader'],
    category: 'rendering',
  },
  screen: {
    aliases: ['gui', 'menu', 'handled screen', 'screen handler', 'container'],
    category: 'gui',
  },
  command: {
    aliases: ['commands', 'brigadier', 'argument', 'command registration'],
    category: 'commands',
  },
  tag: {
    aliases: ['tags', 'item tag', 'block tag', 'tagging'],
    category: 'resources',
  },
  loot: {
    aliases: ['loot table', 'loottable', 'drops', 'loot pool'],
    category: 'resources',
  },
  sound: {
    aliases: ['sounds', 'audio', 'sound event', 'custom sound'],
    category: 'sounds',
  },
  keybind: {
    aliases: ['keybinding', 'key bind', 'hotkey', 'input', 'key mapping'],
    category: 'rendering',
  },
  entity: {
    aliases: ['entities', 'mob', 'creature', 'living entity', 'custom entity'],
    category: 'entities',
  },
  world: {
    aliases: ['worldgen', 'world generation', 'dimension', 'biome', 'feature'],
    category: 'general',
  },
  // 1.12.2-era target-family concepts (DESIGN.md §4.1)
  capabilities: {
    aliases: [
      'capability',
      'capability system',
      'icapabilityprovider',
      'capability provider',
      'attach capabilities',
      'getcapability',
      '@capabilityinject',
      'attachment equivalent',
    ],
    category: 'capabilities',
  },
  'srg names': {
    aliases: [
      'srg',
      'srg name',
      'searge',
      'func_',
      'field_',
      'mcp mappings',
      'obfuscated names',
      'deobfuscation',
    ],
    category: 'mappings',
  },
  coremods: {
    aliases: [
      'coremod',
      'core mod',
      'loading plugin',
      'ifmlloadingplugin',
      'iclasstransformer',
      'class transformer',
      'asm transformation',
    ],
    category: 'coremods-mixins',
  },
  'mcmod.info': {
    aliases: ['mcmod info', 'mod info file', 'mod metadata 1.12'],
    category: 'getting-started',
  },
  creativetabs: {
    aliases: ['creative tab', 'creative tabs', 'creativetab', 'item group', 'itemgroup'],
    category: 'items',
  },
  oredictionary: {
    aliases: ['ore dictionary', 'oredict', 'ore dict', 'ore registration'],
    category: 'items',
  },
  mixinbooter: {
    aliases: [
      'mixin booter',
      'cleanmix',
      'ilatemixinloader',
      'iearlymixinloader',
      'late mixin',
      'early mixin',
      'mixin connector',
      'imixinconnector',
    ],
    category: 'coremods-mixins',
  },
  gameregistry: {
    aliases: [
      'game registry',
      'registryevent',
      'registry event',
      'setregistryname',
      'objectholder',
      '@objectholder',
      'object holder',
      'iforgeregistry',
    ],
    category: 'general',
  },
  'access transformers': {
    aliases: [
      'access transformer',
      'accesstransformer',
      'forge_at.cfg',
      'access widener equivalent',
    ],
    category: 'toolchain',
  },
};

/**
 * Curated code tokens per concept, split by loader role: the target family
 * speaks Forge-1.12.2 idiom, the reference family speaks Fabric/NeoForge
 * idiom. A neutral perspective searches both vocabularies.
 */
const TARGET_CONCEPT_PATTERNS: Record<string, string[]> = {
  capabilities: [
    'ICapabilityProvider',
    'getCapability',
    'CapabilityManager',
    'AttachCapabilitiesEvent',
    '@CapabilityInject',
  ],
  'srg names': ['func_', 'field_', 'ObfuscationReflectionHelper', 'p_'],
  coremods: ['IFMLLoadingPlugin', 'IClassTransformer', 'transformClass'],
  mixinbooter: [
    'ILateMixinLoader',
    'IEarlyMixinLoader',
    'MixinBooter',
    'MixinConfigs',
    'IMixinConnector',
  ],
  gameregistry: [
    'GameRegistry',
    'RegistryEvent',
    '@ObjectHolder',
    'setRegistryName',
    'IForgeRegistry',
  ],
  creativetabs: ['CreativeTabs', 'setCreativeTab', 'getTabIconItem'],
  oredictionary: ['OreDictionary', 'registerOre', 'getOres'],
  'access transformers': ['forge_at.cfg', 'AccessTransformer', 'public-f'],
  'mcmod.info': ['mcmod.info', 'mcversion', 'modid'],
  event: [
    '@SubscribeEvent',
    'MinecraftForge.EVENT_BUS',
    '@Mod.EventHandler',
    'FMLPreInitializationEvent',
  ],
  registry: ['RegistryEvent.Register', 'GameRegistry', 'setRegistryName', '@ObjectHolder'],
  item: ['Item', 'ItemStack', 'setRegistryName', 'setTranslationKey', 'CreativeTabs'],
  block: ['Block', 'IBlockState', 'Material', 'setHardness'],
  blockentity: ['TileEntity', 'ITickable', 'createNewTileEntity', 'readFromNBT'],
  networking: ['SimpleNetworkWrapper', 'IMessage', 'IMessageHandler', 'MessageContext'],
  // Mixin annotations are neutral tokens — identical on CleanMix
  mixin: ['@Mixin', '@Inject', 'CallbackInfo', 'mixins.json'],
  render: ['TileEntitySpecialRenderer', 'TESR', 'ModelLoader', 'IBakedModel'],
  screen: ['GuiScreen', 'GuiContainer', 'Container'],
  sound: ['SoundEvent', 'playSound', 'SoundHandler'],
  keybind: ['KeyBinding', 'ClientRegistry.registerKeyBinding', 'Keyboard'],
};

const REFERENCE_CONCEPT_PATTERNS: Record<string, string[]> = {
  mixin: ['@Mixin', '@Inject', '@Redirect', 'CallbackInfo', '@ModifyVariable'],
  registry: ['Registry.register', 'Registries.', 'RegistryKey', 'Identifier'],
  item: ['Item', 'ItemStack', 'Item.Settings', 'FabricItemSettings'],
  block: ['Block', 'BlockState', 'Block.Settings', 'FabricBlockSettings'],
  entity: ['Entity', 'EntityType', 'LivingEntity', 'FabricEntityTypeBuilder'],
  blockentity: ['BlockEntity', 'BlockEntityType', 'FabricBlockEntityTypeBuilder'],
  networking: [
    'PacketByteBuf',
    'ServerPlayNetworking',
    'ClientPlayNetworking',
    'PayloadTypeRegistry',
  ],
  event: ['Event', 'Callback', 'ServerLifecycleEvents', 'ClientLifecycleEvents'],
  command: ['CommandRegistrationCallback', 'LiteralArgumentBuilder', 'RequiredArgumentBuilder'],
  recipe: ['Recipe', 'RecipeSerializer', 'RecipeType', 'Ingredient'],
  screen: ['Screen', 'HandledScreen', 'ScreenHandler', 'DrawContext'],
  render: ['Renderer', 'RenderLayer', 'VertexConsumer', 'MatrixStack'],
  sound: ['SoundEvent', 'SoundEvents', 'playSound'],
  keybind: ['KeyBinding', 'KeyBindingHelper', 'GLFW'],
};

/**
 * Service for explaining Minecraft modding concepts
 */
export class ConceptService {
  private store: DocumentStore;
  private embeddingGen: EmbeddingGenerator | null = null;
  private embeddingsAvailable = false;
  private initialized = false;

  constructor(dbPath?: string) {
    const finalPath = dbPath || process.env.DB_PATH || getDefaultDbPath(DBS.docs.fileName);
    console.error(`[ConceptService] Using database at: ${finalPath}`);
    this.store = new DocumentStore(finalPath);
  }

  /**
   * Initialize the service (with optimized embedding support)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Check if embeddings are available
    const embCount = this.store.getEmbeddingCount();
    if (embCount > 0) {
      console.error(
        `[ConceptService] Found ${embCount} embeddings, enabling optimized semantic search`
      );
      try {
        this.embeddingGen = new EmbeddingGenerator();
        await this.embeddingGen.initialize();
        this.embeddingsAvailable = true;
        console.error('[ConceptService] Optimized semantic search enabled (batch processing)');
      } catch (error) {
        console.error('[ConceptService] Failed to initialize embeddings:', error);
        this.embeddingsAvailable = false;
      }
    } else {
      console.error('[ConceptService] No embeddings found, using FTS-only search');
    }

    this.initialized = true;
  }

  /**
   * Explain a concept comprehensively, from a loader perspective.
   * The perspective picks the corpus filter (perspectiveToLoaders) and the
   * loader-specific phrasing/code-pattern vocabulary; it defaults to the
   * primary development target.
   */
  async explainConcept(concept: string, loader: Loader = 'cleanroom'): Promise<ConceptExplanation> {
    await this.initialize();

    const normalizedConcept = concept.toLowerCase().trim();
    console.error(
      `[ConceptService] Explaining concept: "${normalizedConcept}" (perspective: ${loader})`
    );

    // Corpus filter for the perspective (undefined = no filter)
    const loaderFilter = perspectiveToLoaders(loader);

    // Expand concept with known aliases
    const expandedTerms = this.expandConcept(normalizedConcept);
    console.error(`[ConceptService] Expanded terms: ${expandedTerms.join(', ')}`);

    // Perform hybrid search
    const scoredChunks = await this.hybridSearch(
      expandedTerms,
      normalizedConcept,
      loader,
      loaderFilter
    );
    console.error(`[ConceptService] Found ${scoredChunks.length} relevant chunks`);

    // Summary and detail rendering share the canonical section cleanup used by
    // search_docs, rather than formatting raw overlapping chunks independently.

    // Extract key points
    const keyPoints = this.extractKeyPoints(scoredChunks, normalizedConcept);

    // Find code examples
    const codeExamples = this.findCodeExamples(
      normalizedConcept,
      expandedTerms,
      loader,
      loaderFilter
    );

    // Extract related concepts
    const relatedConcepts = this.extractRelatedConcepts(scoredChunks, normalizedConcept);

    // Build resources list
    const resources = this.buildResourcesList(scoredChunks);

    const summary = this.generateSummary(scoredChunks, normalizedConcept, keyPoints, loader);
    const details = this.generateDetails(scoredChunks);

    // Cross-loader difference banner via EXACT topic map (never alias expansion — R7).
    const crossLoader = this.lookupCrossLoaderDifferences(normalizedConcept);

    return {
      concept: normalizedConcept,
      summary,
      details,
      keyPoints,
      codeExamples,
      relatedConcepts,
      resources,
      equivalence: crossLoader.length > 0 ? crossLoader : undefined,
      metadata: {
        loader,
        sourcesUsed: new Set(scoredChunks.map((c) => c.documentUrl)).size,
        hasEmbeddings: this.embeddingsAvailable,
        searchStrategy: this.embeddingsAvailable
          ? 'hybrid (FTS + optimized semantic)'
          : 'FTS + section search',
      },
    };
  }

  /**
   * Loader-aware phrasing shared by the semantic query and the fallback
   * summary: the neutral perspective names no loader at all.
   */
  private loaderPhrase(loader: Loader): string {
    return loader === 'shared'
      ? 'in Minecraft modding'
      : `in Minecraft modding with ${LOADERS[loader].displayName}`;
  }

  /**
   * Expand concept with known aliases and synonyms
   */
  private expandConcept(concept: string): string[] {
    const terms = new Set<string>([concept]);

    // Check known concepts
    for (const [key, info] of Object.entries(KNOWN_CONCEPTS)) {
      if (key === concept || info.aliases.some((a) => concept.includes(a) || a.includes(concept))) {
        terms.add(key);
        info.aliases.forEach((a) => terms.add(a));
      }
    }

    // Also check if concept matches any alias
    for (const [key, info] of Object.entries(KNOWN_CONCEPTS)) {
      if (info.aliases.includes(concept)) {
        terms.add(key);
        info.aliases.forEach((a) => terms.add(a));
      }
    }

    // Tokenize and expand using search-utils
    const tokenized = tokenizeQuery(concept);
    tokenized.expandedTokens.forEach((t) => terms.add(t));

    return Array.from(terms);
  }

  /**
   * Perform hybrid search combining FTS and semantic search
   */
  private async hybridSearch(
    terms: string[],
    originalConcept: string,
    loader: Loader,
    loaderFilter: Loader[] | undefined
  ): Promise<ScoredChunk[]> {
    const allChunks = new Map<string, ScoredChunk>();

    // Strategy 1: FTS search on chunks
    const ftsQuery = terms.filter((t) => t.length > 2).join(' OR ');
    const ftsResults = this.store.searchChunksAdvanced(
      ftsQuery,
      terms.map((t) => `%${t}%`),
      { hasCode: false, loader: loaderFilter, limit: 50 }
    );

    for (const chunk of ftsResults) {
      const key = chunk.id;
      allChunks.set(key, {
        id: chunk.id,
        content: chunk.content,
        sectionHeading: chunk.section_heading,
        documentTitle: chunk.title,
        documentUrl: chunk.url,
        category: chunk.category,
        score: 50, // Base FTS score
        hasCode: chunk.has_code === 1,
      });
    }

    // Strategy 2: Section search
    const sectionResults = this.store.searchSections(originalConcept, {
      loader: loaderFilter,
      limit: 30,
    });
    for (const section of sectionResults) {
      const key = `section-${section.id}`;
      if (!allChunks.has(key)) {
        allChunks.set(key, {
          id: key,
          content: section.content,
          sectionHeading: section.heading,
          documentTitle: section.document_title,
          documentUrl: section.document_url,
          category: section.category,
          score: 40,
          hasCode: false,
        });
      }
    }

    // Strategy 3: Optimized semantic search (batch-based processing).
    // Semantic matches only boost chunks the SQL strategies already found,
    // so the loader filter above bounds this strategy too.
    if (this.embeddingsAvailable && this.embeddingGen) {
      try {
        const queryEmbedding = await this.embeddingGen.generateEmbedding(
          `Explain ${originalConcept} ${this.loaderPhrase(loader)}`
        );

        // Process embeddings in batches to avoid memory issues
        const batchSize = 500;
        const totalEmbeddings = this.store.getEmbeddingCount();
        const topK = 30;
        const topMatches: Array<{ chunkId: string; similarity: number }> = [];

        for (let offset = 0; offset < totalEmbeddings; offset += batchSize) {
          const batchEmbeddings = this.store.getEmbeddingsBatch(batchSize, offset);

          // Calculate similarity for this batch
          for (const emb of batchEmbeddings) {
            const similarity = this.cosineSimilarity(queryEmbedding, emb.embedding);
            topMatches.push({ chunkId: emb.chunkId, similarity });
          }

          // Keep only top-K to limit memory usage
          if (topMatches.length > topK * 2) {
            topMatches.sort((a, b) => b.similarity - a.similarity);
            topMatches.length = topK * 2;
          }
        }

        // Sort and get final top-K results
        topMatches.sort((a, b) => b.similarity - a.similarity);
        const finalMatches = topMatches.slice(0, topK);

        // Boost scores for semantic matches
        for (const match of finalMatches) {
          const existing = allChunks.get(match.chunkId);
          if (existing) {
            existing.score += match.similarity * 60;
          }
        }
      } catch (error) {
        console.error('[ConceptService] Semantic search failed:', error);
      }
    }

    // Apply relevance boosting based on content
    for (const chunk of allChunks.values()) {
      const contentLower = chunk.content.toLowerCase();
      const headingLower = (chunk.sectionHeading || '').toLowerCase();

      // Boost for exact concept mention
      if (contentLower.includes(originalConcept)) {
        chunk.score += 30;
      }
      if (headingLower.includes(originalConcept)) {
        chunk.score += 40;
      }

      // Boost for term frequency
      for (const term of terms) {
        if (term.length < 3) continue;
        const termLower = term.toLowerCase();
        const count = (contentLower.match(new RegExp(termLower, 'g')) || []).length;
        chunk.score += Math.min(count * 5, 25);
      }

      // Boost for having code (practical examples)
      if (chunk.hasCode) {
        chunk.score += 15;
      }
    }

    // Sort by score and return top results
    const sorted = Array.from(allChunks.values()).sort((a, b) => b.score - a.score);
    return sorted.slice(0, 30);
  }

  /**
   * Extract complete, deduplicated section bodies in rank order.
   */
  private canonicalContent(
    chunks: ScoredChunk[],
    limit: number
  ): Array<{
    heading: string;
    content: string;
  }> {
    return canonicalSections(
      chunks.map((chunk) => ({
        heading: chunk.sectionHeading || chunk.documentTitle || 'Overview',
        content: cleanDocumentationText(chunk.content),
      })),
      limit
    );
  }

  /**
   * Extract key points from chunks
   */
  private extractKeyPoints(chunks: ScoredChunk[], concept: string): string[] {
    const keyPoints: string[] = [];
    const seenPoints = new Set<string>();

    for (const section of this.canonicalContent(chunks.slice(0, 20), 10)) {
      const sentences = section.content.split(/[.!?]+/);
      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed.length < 20 || trimmed.length > 200 || /^[a-z]/.test(trimmed)) continue;

        const lowerSentence = trimmed.toLowerCase();
        if (lowerSentence.includes(concept) || this.containsKeyTerms(lowerSentence, concept)) {
          const key = cleanDocumentationText(trimmed).toLowerCase();
          if (!seenPoints.has(key)) {
            seenPoints.add(key);
            keyPoints.push(trimmed);
          }
        }
      }

      if (keyPoints.length >= 8) break;
    }

    return keyPoints.slice(0, 8);
  }

  /**
   * Check if text contains key terms related to concept
   */
  private containsKeyTerms(text: string, concept: string): boolean {
    const knownInfo = KNOWN_CONCEPTS[concept];
    if (!knownInfo) return false;

    return knownInfo.aliases.some((alias) => text.includes(alias.toLowerCase()));
  }

  /**
   * Find code examples for the concept
   */
  private findCodeExamples(
    concept: string,
    terms: string[],
    loader: Loader,
    loaderFilter: Loader[] | undefined
  ): ConceptExplanation['codeExamples'] {
    const examples: ConceptExplanation['codeExamples'] = [];
    const seenCode = new Set<string>();

    // Search code blocks by patterns
    const codePatterns = this.getCodePatterns(concept, terms, loader);
    const codeResults = this.store.searchCodeBlocksByPatterns(codePatterns, {
      language: 'java',
      loader: loaderFilter,
      limit: 15,
    });

    for (const block of codeResults) {
      // Deduplicate by code content
      const codeKey = block.code.substring(0, 100);
      if (seenCode.has(codeKey)) continue;
      seenCode.add(codeKey);

      // Skip very short or very long code
      if (block.code.length < 30 || block.code.length > 2000) continue;

      examples.push({
        language: block.language,
        code: block.code,
        caption: block.caption || undefined,
        context: block.section_heading || block.document_title,
        sourceUrl: block.document_url,
      });

      if (examples.length >= 5) break;
    }

    // Also search in chunks with code
    if (examples.length < 3) {
      const codeChunks = this.store.searchChunksAdvanced(
        terms.filter((t) => t.length > 2).join(' OR '),
        terms.map((t) => `%${t}%`),
        { hasCode: true, loader: loaderFilter, limit: 20 }
      );

      for (const chunk of codeChunks) {
        if (examples.length >= 5) break;

        // Extract code from chunk content
        const codeMatch = chunk.content.match(/```[\s\S]*?```|`[^`]+`/);
        if (codeMatch) {
          const code = codeMatch[0].replace(/```\w*\n?|```|`/g, '').trim();
          const codeKey = code.substring(0, 100);
          if (!seenCode.has(codeKey) && code.length > 30) {
            seenCode.add(codeKey);
            examples.push({
              language: chunk.code_language || 'java',
              code,
              context: chunk.section_heading || chunk.title,
              sourceUrl: chunk.url,
            });
          }
        }
      }
    }

    return examples;
  }

  /**
   * Get code patterns for a concept.
   * Curated API tokens go FIRST: searchCodeBlocksByPatterns only uses the
   * first 5 patterns, and the generic alias-derived ones are far weaker.
   */
  private getCodePatterns(concept: string, terms: string[], loader: Loader): string[] {
    const patterns: string[] = [];

    // Curated tokens for the perspective's API vocabulary
    const role = LOADERS[loader].role;
    if (role !== 'reference') {
      patterns.push(...(TARGET_CONCEPT_PATTERNS[concept] ?? []));
    }
    if (role !== 'target') {
      patterns.push(...(REFERENCE_CONCEPT_PATTERNS[concept] ?? []));
    }

    // Generic patterns derived from the expanded terms
    for (const term of terms) {
      if (term.length > 3) {
        patterns.push(term);
        // Add PascalCase version
        patterns.push(term.charAt(0).toUpperCase() + term.slice(1));
      }
    }

    return [...new Set(patterns)];
  }

  /**
   * Extract related concepts from chunks
   */
  private extractRelatedConcepts(chunks: ScoredChunk[], excludeConcept: string): string[] {
    const related = new Map<string, number>();

    for (const chunk of chunks) {
      const contentLower = chunk.content.toLowerCase();

      for (const [concept, info] of Object.entries(KNOWN_CONCEPTS)) {
        if (concept === excludeConcept) continue;

        // Check if concept or aliases are mentioned
        if (contentLower.includes(concept)) {
          related.set(concept, (related.get(concept) || 0) + 3);
        }

        for (const alias of info.aliases) {
          if (contentLower.includes(alias.toLowerCase())) {
            related.set(concept, (related.get(concept) || 0) + 1);
          }
        }
      }
    }

    // Sort by frequency and return top related concepts
    return Array.from(related.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([concept]) => concept);
  }

  /**
   * Build resources list from chunks
   */
  private buildResourcesList(chunks: ScoredChunk[]): ConceptExplanation['resources'] {
    const resourceMap = new Map<string, { title: string; url: string; score: number }>();

    for (const chunk of chunks) {
      const existing = resourceMap.get(chunk.documentUrl);
      if (existing) {
        existing.score = Math.max(existing.score, chunk.score);
      } else {
        resourceMap.set(chunk.documentUrl, {
          title: chunk.documentTitle,
          url: chunk.documentUrl,
          score: chunk.score,
        });
      }
    }

    return Array.from(resourceMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((r) => ({
        title: r.title,
        url: r.url,
        relevance: Math.round((r.score / 100) * 100) / 100,
      }));
  }

  /**
   * Generate a summary through the same complete-sentence selector as
   * search_docs. The document's lead section (its heading equals its title) is
   * preferred over ranked subsections, which keeps Overview prose authoritative.
   */
  private generateSummary(
    chunks: ScoredChunk[],
    concept: string,
    keyPoints: string[],
    loader: Loader
  ): string {
    const prioritized = [...chunks].sort((a, b) => {
      const aLead = a.sectionHeading === a.documentTitle ? 0 : 1;
      const bLead = b.sectionHeading === b.documentTitle ? 0 : 1;
      return aLead - bLead;
    });
    const sections = this.canonicalContent(prioritized, 12);
    const summary = canonicalSummary(
      [...sections.map((section) => section.content), ...keyPoints],
      [concept],
      300
    );

    return summary || `${concept} is a concept ${this.loaderPhrase(loader)}.`;
  }

  /**
   * Generate detailed explanation from canonical sections. One body per
   * heading removes overlapping chunks and rejects mid-sentence fragments.
   */
  private generateDetails(chunks: ScoredChunk[]): string {
    return this.canonicalContent(chunks.slice(0, 30), 8)
      .map((section) => {
        const summary = canonicalSummary([section.content], [], 600);
        return summary ? `**${section.heading}:**\n${summary}` : '';
      })
      .filter(Boolean)
      .join('\n\n---\n\n');
  }

  /**
   * Format explanation for AI consumption
   */
  /**
   * Look up cross-loader difference rows for a concept via the EXACT CONCEPT_TO_TOPIC map.
   * Returns [] unless the concept id is a literal key and the corpus (schema v2) is present.
   */
  private lookupCrossLoaderDifferences(conceptId: string): EquivalenceMatch[] {
    const topic = CONCEPT_TO_TOPIC[conceptId];
    if (!topic) return [];
    try {
      const v = this.store.getSchemaVersion();
      if (v === null || v < 2) return [];
      return this.store.equivalenceByTopic(topic, 8).map(equivalenceRowToMatch);
    } catch {
      return [];
    }
  }

  formatForAI(explanation: ConceptExplanation): string {
    let output = `# Understanding: ${explanation.concept}\n\n`;

    // Summary
    output += `## Summary\n${explanation.summary}\n\n`;

    // Key Points
    if (explanation.keyPoints.length > 0) {
      output += `## Key Points\n`;
      for (const point of explanation.keyPoints) {
        output += `- ${point}\n`;
      }
      output += '\n';
    }

    // Detailed Explanation
    if (explanation.details) {
      output += `## Detailed Explanation\n${explanation.details}\n\n`;
    }

    // Code Examples
    if (explanation.codeExamples.length > 0) {
      output += `## Code Examples\n\n`;
      for (let i = 0; i < explanation.codeExamples.length; i++) {
        const example = explanation.codeExamples[i];
        if (!example) continue;
        output += `### Example ${i + 1}: ${example.context}\n`;
        if (example.caption) {
          output += `*${example.caption}*\n`;
        }
        output += `\`\`\`${example.language}\n${example.code}\n\`\`\`\n`;
        output += `Source: ${example.sourceUrl}\n\n`;
      }
    }

    // Related Concepts
    if (explanation.relatedConcepts.length > 0) {
      output += `## Related Concepts\n`;
      output += explanation.relatedConcepts.map((c) => `- ${c}`).join('\n');
      output += '\n\n';
    }

    // Resources
    if (explanation.resources.length > 0) {
      output += `## Documentation Resources\n`;
      for (const resource of explanation.resources.slice(0, 6)) {
        output += `- [${resource.title}](${resource.url})\n`;
      }
      output += '\n';
    }

    // Cross-loader differences (Phase 4 banner)
    if (explanation.equivalence && explanation.equivalence.length > 0) {
      output += `## Cross-loader differences\n`;
      output +=
        `How this concept maps from other loaders to Cleanroom/Forge 1.12.2 ` +
        `(via \`find_equivalent\`):\n\n`;
      for (const m of explanation.equivalence) {
        const target =
          m.kind === 'missing'
            ? 'No 1.12.2 equivalent — hand-write the idiom'
            : `\`${m.toApi ?? ''}\` (${m.toLoader})`;
        output += `- **${m.fromVocab}** \`${m.fromApi}\` → ${target} _(${m.kind})_\n`;
      }
      output += `\nUse \`find_equivalent(query, from)\` for full details, code, and caveats.\n\n`;
    }

    // Metadata
    output += `---\n`;
    output += `*Perspective: ${LOADERS[explanation.metadata.loader].displayName} | `;
    output += `Sources: ${explanation.metadata.sourcesUsed} documents | `;
    output += `Search: ${explanation.metadata.searchStrategy}*\n`;

    return output;
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < a.length; i++) {
      const aVal = a[i] ?? 0;
      const bVal = b[i] ?? 0;
      dotProduct += aVal * bVal;
      magnitudeA += aVal * aVal;
      magnitudeB += bVal * bVal;
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
  }

  /**
   * Close resources
   */
  close() {
    this.store.close();
  }
}
