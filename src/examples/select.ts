/**
 * Snippet selection (pipeline stage 2).
 *
 * Turns raw .java files into candidate Snippets — coherent method/class regions
 * with file/line provenance — constrained by the roster manifest's
 * include/exclude globs, maxFileBytes, maxSnippetsPerRepo, and the per-snippet
 * line cap (excerpt discipline, DESIGN §3/§6.2). Pure and deterministic.
 *
 * "No silent caps": whenever a file or candidate is dropped, it is logged with
 * the repo name, the reason, and the file(s) affected (DESIGN §3).
 */

import type { RawFile, SelectConfig, Snippet, PipelineLogger } from './model.js';
import type { Loader } from '../loaders.js';

const DEFAULT_MAX_SNIPPET_LINES = 60;

/** Convert a glob (`**`, `*`, `?`) to an anchored RegExp over a path string. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**' matches across path separators; consume an optional trailing '/'.
        re += '.*';
        i++;
        if (glob[i + 1] === '/') {
          i++;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) {
    return true; // absent include = match all
  }
  return globs.some((g) => globToRegExp(g).test(path));
}

function matchesAnyExclude(path: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) {
    return false;
  }
  return globs.some((g) => globToRegExp(g).test(path));
}

/** Fully-qualified import paths declared in a source file. */
export function detectImports(content: string): string[] {
  const imports: string[] = [];
  const re = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    imports.push(m[1]!);
  }
  return imports;
}

/** Net brace delta of a line (called on literal-masked lines only). */
function braceDelta(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }
  return delta;
}

/**
 * Blank out the contents of Java string/char literals and line/block comments,
 * preserving every character position and newline, so brace counting never trips
 * over a brace inside a string, char literal, or comment. Real modding code is
 * full of such braces (log/format/JSON/NBT strings, commented-out code, regex).
 */
export function maskLiterals(content: string): string {
  let out = '';
  let state: 'normal' | 'line' | 'block' | 'string' | 'char' | 'textblock' = 'normal';
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!;
    const n = content[i + 1];
    if (state === 'normal') {
      if (c === '/' && n === '/') {
        state = 'line';
        out += '  ';
        i++;
      } else if (c === '/' && n === '*') {
        state = 'block';
        out += '  ';
        i++;
      } else if (c === '"' && content.startsWith('"""', i)) {
        // Java text block: spans newlines until the closing """.
        state = 'textblock';
        out += '   ';
        i += 2;
      } else if (c === '"') {
        state = 'string';
        out += ' ';
      } else if (c === "'") {
        state = 'char';
        out += ' ';
      } else {
        out += c;
      }
      continue;
    }
    if (c === '\n') {
      // Newlines always pass through (keeps line indices aligned). A raw newline
      // also terminates //-comments and (defensively) any unclosed string/char,
      // but NOT a text block, which is multi-line by definition.
      if (state === 'line' || state === 'string' || state === 'char') state = 'normal';
      out += '\n';
      continue;
    }
    if (state === 'textblock') {
      if (c === '"' && content.startsWith('"""', i)) {
        state = 'normal';
        out += '   ';
        i += 2;
      } else {
        out += ' ';
      }
    } else if (state === 'line') {
      out += ' ';
    } else if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'normal';
        out += '  ';
        i++;
      } else {
        out += ' ';
      }
    } else {
      // string or char: honor escapes so an escaped quote doesn't end the literal.
      if (c === '\\' && n !== undefined && n !== '\n') {
        out += '  ';
        i++;
      } else if ((state === 'string' && c === '"') || (state === 'char' && c === "'")) {
        state = 'normal';
        out += ' ';
      } else {
        out += ' ';
      }
    }
  }
  return out;
}

interface Region {
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
  code: string;
}

/**
 * Extract member-level regions (methods, constructors, nested types) by tracking
 * brace depth: a line at class-body depth (1) that opens a new brace begins a
 * region that closes when depth returns to 1. Leading annotation/signature lines
 * are folded in. Best-effort; the LLM re-derives semantics downstream.
 */
export function extractRegions(content: string, maxLines: number): Region[] {
  const lines = content.split('\n');
  // Depth/boundary decisions run on literal-masked lines; emitted code slices
  // come from the original lines. Both arrays share line count + alignment.
  const masked = maskLiterals(content).split('\n');
  const regions: Region[] = [];
  let depth = 0;
  let i = 0;

  // Advance to the first top-level type body (depth 0 -> 1).
  while (i < lines.length && depth < 1) {
    depth += braceDelta(masked[i]!);
    i++;
  }

  for (; i < lines.length; i++) {
    const before = depth;
    depth += braceDelta(masked[i]!);
    // A member region opens when we step from class-body depth (1) deeper — but
    // not on an annotation line, whose brace is an array initializer (@Foo({...}))
    // rather than a member body; depth self-corrects when the array closes.
    if (before === 1 && depth > 1 && !masked[i]!.trim().startsWith('@')) {
      let start = i;
      // Fold in immediately-preceding annotation / multi-line signature lines.
      while (start > 0) {
        const prev = masked[start - 1]!.trim();
        if (prev === '' || prev.endsWith(';') || prev.endsWith('}') || prev.endsWith('{')) {
          break;
        }
        start--;
      }
      // Consume to the matching close (depth back to 1).
      let j = i;
      while (j + 1 < lines.length && depth > 1) {
        j++;
        depth += braceDelta(masked[j]!);
      }
      const endLine = j + 1;
      const startLine = start + 1;
      if (endLine - startLine + 1 <= maxLines) {
        regions.push({
          startLine,
          endLine,
          code: lines.slice(start, j + 1).join('\n'),
        });
      } else {
        // Over-cap region: signal via a sentinel the caller logs and drops.
        regions.push({ startLine, endLine, code: '' });
      }
      i = j;
    }
  }
  return regions;
}

/**
 * Select snippets from a repo's files under its caps. Files may omit `content`
 * (pure cap tests) — those yield a single whole-file placeholder candidate.
 */
export function selectSnippets(
  files: RawFile[],
  cfg: SelectConfig,
  logger: PipelineLogger
): Snippet[] {
  const maxLines = cfg.maxSnippetLines ?? DEFAULT_MAX_SNIPPET_LINES;
  const loader: Loader = cfg.loader ?? 'forge';
  const modName = cfg.modName ?? cfg.repo.split('/').pop() ?? cfg.repo;
  const license = cfg.license ?? '';
  const ref = cfg.ref ?? 'master';

  const candidates: Snippet[] = [];

  for (const file of files) {
    if (!matchesAny(file.path, cfg.include)) {
      continue;
    }
    if (matchesAnyExclude(file.path, cfg.exclude)) {
      continue;
    }
    if (file.bytes > cfg.maxFileBytes) {
      logger.log(`[${cfg.repo}] skip (over maxFileBytes ${cfg.maxFileBytes}): ${file.path}`);
      continue;
    }

    const imports = file.content ? detectImports(file.content) : [];
    const makeSnippet = (startLine: number, endLine: number, code: string): Snippet => ({
      repo: cfg.repo,
      modName,
      loader,
      license,
      filePath: file.path,
      fileUrl: `https://github.com/${cfg.repo}/blob/${ref}/${file.path}#L${startLine}-L${endLine}`,
      startLine,
      endLine,
      code,
      language: 'java',
      imports,
    });

    if (!file.content) {
      candidates.push(makeSnippet(1, 1, ''));
      continue;
    }

    const regions = extractRegions(file.content, maxLines);
    const kept = regions.filter((r) => r.code !== '');
    const overCap = regions.filter((r) => r.code === '');
    for (const r of overCap) {
      logger.log(
        `[${cfg.repo}] drop region over ${maxLines} lines (${file.path}:${r.startLine}-${r.endLine})`
      );
    }
    if (kept.length === 0) {
      // No member region under the cap — fall back to a capped whole-file excerpt.
      const total = file.content.split('\n').length;
      if (total <= maxLines) {
        candidates.push(makeSnippet(1, total, file.content));
      } else {
        const head = file.content.split('\n').slice(0, maxLines).join('\n');
        logger.log(
          `[${cfg.repo}] truncate ${file.path} to first ${maxLines} of ${total} lines (no region under cap)`
        );
        candidates.push(makeSnippet(1, maxLines, head));
      }
      continue;
    }
    for (const r of kept) {
      candidates.push(makeSnippet(r.startLine, r.endLine, r.code));
    }
  }

  // Enforce the per-repo snippet cap; log exactly which files/regions were dropped.
  if (cfg.maxSnippetsPerRepo !== null && candidates.length > cfg.maxSnippetsPerRepo) {
    const kept = candidates.slice(0, cfg.maxSnippetsPerRepo);
    const dropped = candidates.slice(cfg.maxSnippetsPerRepo);
    const droppedFiles = [...new Set(dropped.map((s) => s.filePath))];
    logger.log(
      `[${cfg.repo}] cap: keeping ${kept.length}/${candidates.length} snippets ` +
        `(maxSnippetsPerRepo=${cfg.maxSnippetsPerRepo}); dropped ${dropped.length} from: ` +
        droppedFiles.join(', ')
    );
    return kept;
  }

  return candidates;
}
