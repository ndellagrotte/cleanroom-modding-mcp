/**
 * web-tree-sitter bootstrap for Java parsing.
 *
 * Loads the tree-sitter-java grammar from the .wasm file shipped inside the
 * tree-sitter-java npm package (the package's native binding is never built —
 * it sits in pnpm's ignoredBuiltDependencies; only the wasm is used). Both
 * packages are devDependencies: this module is reached only from
 * scripts/index-java-api.ts and tests, never from the runtime server.
 */

import path from 'path';
import { createRequire } from 'module';
import { Parser, Language } from 'web-tree-sitter';
import type { JavaParser } from './model.js';

let languagePromise: Promise<Language> | null = null;

/** Resolve the tree-sitter-java.wasm path without executing that package's JS. */
export function javaWasmPath(): string {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve('tree-sitter-java/package.json');
  return path.join(path.dirname(pkgJsonPath), 'tree-sitter-java.wasm');
}

async function loadJavaLanguage(): Promise<Language> {
  if (!languagePromise) {
    languagePromise = (async (): Promise<Language> => {
      await Parser.init();
      return Language.load(javaWasmPath());
    })();
    // Don't cache a rejection: a transient wasm-load failure must not poison
    // every later createJavaParser() in this process.
    languagePromise.catch(() => {
      languagePromise = null;
    });
  }
  return languagePromise;
}

/**
 * Create a parser bound to the Java grammar. Callers reuse one instance across
 * files; parse() returns null only on parser-internal failure (callers skip the
 * file and count it).
 */
export async function createJavaParser(): Promise<JavaParser> {
  const language = await loadJavaLanguage();
  const parser = new Parser();
  parser.setLanguage(language);
  // web-tree-sitter's Parser/Node satisfy the structural JavaParser/TsNode
  // interfaces; the cast keeps web-tree-sitter types out of our public surface.
  return parser;
}
