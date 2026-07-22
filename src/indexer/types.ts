/**
 * Type definitions for the indexer
 */

import type { Loader } from '../loaders.js';

export interface DocumentPage {
  url: string;
  title: string;
  content: string;
  rawHtml: string;
  category: string;
  loader: Loader;
  minecraftVersion?: string;
  sections: DocumentSection[];
  metadata: PageMetadata;
  hash: string; // For change detection
}

export interface SearchCandidate {
  documentId: number;
  sectionId: number;
  sectionHeading: string;
  documentTitle: string;
  documentUrl: string;
  category: string;
  score: number;
}

export type Param = string | number | boolean | null;

export interface DocumentSection {
  heading: string;
  level: number; // h1=1, h2=2, etc.
  content: string;
  codeBlocks: CodeBlock[];
  order: number;
}

export interface CodeBlock {
  language: string;
  code: string;
  caption?: string;
}

export interface PageMetadata {
  crawledAt: Date;
  lastModified?: Date;
  author?: string;
  tags: string[];
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
}

export interface CrawlerOptions {
  maxConcurrency: number;
  delayMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  userAgent: string;
  timeout: number;
}

export interface IndexerProgress {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  currentUrl?: string;
  startTime: Date;
  estimatedTimeRemaining?: number;
}

export interface IndexStats {
  totalDocuments: number;
  totalSections: number;
  totalCodeBlocks: number;
  lastUpdated: Date;
  version: string;
  /** Document count per loader id — dynamic so unknown loaders are never dropped. */
  loaders: Record<string, number>;
}

export interface ChunkOptions {
  maxChunkSize: number;
  overlapSize: number;
  preserveCodeBlocks: boolean;
  minChunkSize: number;
}
