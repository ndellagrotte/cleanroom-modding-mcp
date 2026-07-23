#!/usr/bin/env tsx

/**
 * Build-time equivalence corpus compiler.
 *
 * Reads data/equivalence/*.yaml, validates + compiles each entry via the pure
 * src/equivalence/validate.ts, and returns rows ready for DocumentStore.replaceEquivalence.
 *
 * This is the ONLY place the `yaml` dependency is imported — it lives in scripts/, which
 * tsx runs directly and tsc never compiles into dist/. Nothing under dist/ parses YAML.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { parse } from 'yaml';
import {
  validateTopicFile,
  crossValidate,
  type AuthoredTopicFile,
} from '../src/equivalence/validate.js';
import type { CompiledEquivalenceEntry } from '../src/equivalence/types.js';

export interface CompileResult {
  entries: CompiledEquivalenceEntry[];
  errors: string[];
  fileCount: number;
}

export async function compileEquivalence(dir: string): Promise<CompileResult> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  } catch {
    // Directory absent → empty corpus (the compile stage is a no-op, not an error).
    return { entries: [], errors: [], fileCount: 0 };
  }

  const entries: CompiledEquivalenceEntry[] = [];
  const errors: string[] = [];

  for (const f of files) {
    const raw = await readFile(join(dir, f), 'utf8');
    let parsed: unknown;
    try {
      parsed = parse(raw);
    } catch (err) {
      errors.push(`${f}: YAML parse error: ${(err as Error).message}`);
      continue;
    }
    const res = validateTopicFile(parsed as AuthoredTopicFile, f);
    errors.push(...res.errors);
    entries.push(...res.entries);
  }

  errors.push(...crossValidate(entries));
  return { entries, errors, fileCount: files.length };
}
