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
 *
 * When maxSnippetsPerRepo binds, the kept set is spread across the repo's
 * package tree and biased toward category-bearing code (DESIGN §6.2) rather
 * than taken off the head of the tree walk — see selectUnderCap.
 */

import type { RawFile, SelectConfig, Snippet, PipelineLogger } from './model.js';
import type { Loader } from '../loaders.js';

const DEFAULT_MAX_SNIPPET_LINES = 60;
/** Pass-1 soft quota: how many snippets one file may claim while the cap binds. */
const MAX_KEPT_PER_FILE_UNDER_CAP = 3;
/** A region this short is a getter/delegate — signature, one statement, brace. */
const TRIVIAL_REGION_LINES = 3;
/** Starved-file list length in the cap log line (the full list is ~1000 paths). */
const MAX_LOGGED_STARVED_FILES = 15;
/**
 * Directory names DESIGN §6.2 names as low-value ("skip generated/integration
 * packages"). Here they are a demotion, never a skip: skipping would change the
 * under-cap output and break selectSnippets' identity guarantee. The roster's
 * `exclude` globs own skipping; this module owns preference.
 */
const DEMOTED_DIR_SEGMENTS = new Set(['generated', 'integration']);

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

// ─────────────────────────────────────────────────────────────────────────────
// Cap selection (DESIGN §6.2) — spread the budget, prefer category-bearing code
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Selection markers.
 *
 * THIS IS NOT A TAXONOMY. It never reaches the database: `src/categories.ts`
 * owns EXAMPLE_CATEGORIES and the LLM assigns each example's real category
 * downstream. These are coarse tiebreak hints, used only when
 * maxSnippetsPerRepo forces a choice between candidates.
 *
 * The groups are deliberately skewed toward patterns the corpus under-serves
 * and that are identifiable from imports alone. `blocks`, `items` and
 * `rendering` are absent on purpose — they dominate any Minecraft repo by sheer
 * volume and need no help winning a tiebreak.
 *
 * Half of each group's evidence is file-level (`imports` is per-file, so every
 * candidate from one file shares it) — that half discriminates between files
 * and packages. The `code` half discriminates between regions inside one file.
 * `code` is matched unmasked, so a marker inside a comment counts; acceptable
 * for a tiebreak, and cheaper than masking every region a second time.
 */
const SELECTION_MARKERS: ReadonlyArray<{ name: string; needles: readonly string[] }> = [
  {
    name: 'capability',
    needles: [
      'common.capabilities',
      'ICapabilityProvider',
      'CapabilityInject',
      'CapabilityManager',
      'hasCapability',
      'getCapability',
    ],
  },
  {
    name: 'handlers',
    needles: [
      'net.minecraftforge.items',
      'IItemHandler',
      'ItemStackHandler',
      'net.minecraftforge.fluids',
      'IFluidHandler',
      'FluidTank',
      'IEnergyStorage',
      'CapabilityEnergy',
    ],
  },
  {
    name: 'networking',
    needles: [
      'network.simpleimpl',
      'SimpleNetworkWrapper',
      'IMessageHandler',
      'MessageContext',
      'PacketBuffer',
    ],
  },
  {
    name: 'tile-entity',
    needles: [
      'tileentity.TileEntity',
      'ITickable',
      'readFromNBT',
      'writeToNBT',
      'NBTTagCompound',
      'SPacketUpdateTileEntity',
    ],
  },
  {
    name: 'events',
    needles: ['fml.common.eventhandler', '@SubscribeEvent', 'MinecraftForge.EVENT_BUS'],
  },
  {
    name: 'registry',
    needles: [
      '@ObjectHolder',
      'RegistryEvent',
      'GameRegistry',
      'IForgeRegistry',
      'ForgeRegistries',
    ],
  },
  {
    name: 'recipes',
    needles: [
      'item.crafting.IRecipe',
      'ShapedOreRecipe',
      'ShapelessOreRecipe',
      'FurnaceRecipes',
      'CraftingHelper',
    ],
  },
  {
    name: 'worldgen',
    needles: ['IWorldGenerator', 'registerWorldGenerator', 'world.gen', 'world.biome.Biome'],
  },
  {
    name: 'commands',
    needles: ['command.ICommand', 'CommandBase', 'ICommandSender', 'CommandException'],
  },
  { name: 'sounds', needles: ['util.SoundEvent', 'SoundCategory', 'playSound'] },
  {
    name: 'entities',
    needles: ['EntityEntry', 'registerModEntity', 'entity.ai', 'EntityAIBase', 'DataParameter'],
  },
  {
    name: 'mixins',
    needles: [
      'org.spongepowered.asm.mixin',
      '@Mixin',
      '@Redirect',
      'IFMLLoadingPlugin',
      'IClassTransformer',
      'IMixinConfigPlugin',
    ],
  },
  {
    name: 'gui',
    needles: ['GuiContainer', 'inventory.Container', 'inventory.Slot', 'IGuiHandler'],
  },
  { name: 'particles', needles: ['EnumParticleTypes', 'spawnParticle', 'ParticleManager'] },
];

/**
 * Marker group names present in `text`, in SELECTION_MARKERS order. Plain
 * substring matching — a /g regex carries `lastIndex` between calls and would
 * make selection non-deterministic.
 */
export function matchMarkers(text: string): string[] {
  const hits: string[] = [];
  for (const group of SELECTION_MARKERS) {
    if (group.needles.some((needle) => text.includes(needle))) {
      hits.push(group.name);
    }
  }
  return hits;
}

/** A candidate plus the integer keys the cap ordering is built from. */
interface Ranked {
  snippet: Snippet;
  /** Original candidate index — the total-order tiebreak, and the emit order. */
  index: number;
  /** 1 = a directory segment of the path is generated/integration. */
  penalty: 0 | 1;
  /** 1 = short enough to be a getter/delegate rather than a teachable unit. */
  trivial: 0 | 1;
  /** Distinct SELECTION_MARKERS groups matched by imports ∪ code. */
  score: number;
  markers: readonly string[];
}

/**
 * The one total order, used both for candidates inside a file and for siblings
 * (via their stream head). Every term is an integer, so it never depends on
 * sort stability.
 *
 * `trivial` outranks `score` deliberately: `imports` is file-level, so every
 * region of a capability-bearing file already carries that file's score, and
 * score-first would pick a one-line `getCap()` accessor over the real
 * `getCapability` implementation beside it.
 */
function compareRanked(a: Ranked, b: Ranked): number {
  return a.penalty - b.penalty || a.trivial - b.trivial || b.score - a.score || a.index - b.index;
}

/** Directory part of a repo-relative path ('' for a file at the repo root). */
function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

/**
 * True when a *directory* segment is demoted. The basename is excluded on
 * purpose: `TinkerIntegration.java` is a mod's bootstrap class, not an
 * integration package. Segments are compared whole, so `generators` is not
 * `generated`.
 */
function inDemotedDirectory(filePath: string): boolean {
  const segments = filePath.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (DEMOTED_DIR_SEGMENTS.has(segments[i]!)) {
      return true;
    }
  }
  return false;
}

function rankCandidates(candidates: Snippet[]): Ranked[] {
  // imports and path are file-level; compute each once per file, not per region.
  const importMarkersByFile = new Map<string, string[]>();
  const penaltyByFile = new Map<string, 0 | 1>();
  return candidates.map((snippet, index) => {
    let importMarkers = importMarkersByFile.get(snippet.filePath);
    if (importMarkers === undefined) {
      importMarkers = matchMarkers(snippet.imports.join('\n'));
      importMarkersByFile.set(snippet.filePath, importMarkers);
    }
    let penalty = penaltyByFile.get(snippet.filePath);
    if (penalty === undefined) {
      penalty = inDemotedDirectory(snippet.filePath) ? 1 : 0;
      penaltyByFile.set(snippet.filePath, penalty);
    }
    const markers = new Set(importMarkers);
    for (const marker of matchMarkers(snippet.code)) {
      markers.add(marker);
    }
    return {
      snippet,
      index,
      penalty,
      trivial: snippet.endLine - snippet.startLine + 1 <= TRIVIAL_REGION_LINES ? 1 : 0,
      score: markers.size,
      markers: [...markers],
    };
  });
}

/** Round-robin: element 0 of every list in order, then element 1, … */
function interleave<T>(lists: T[][], limit: number): T[] {
  const out: T[] = [];
  for (let layer = 0; out.length < limit; layer++) {
    let progressed = false;
    for (const list of lists) {
      if (layer < list.length) {
        out.push(list[layer]!);
        progressed = true;
        if (out.length >= limit) break;
      }
    }
    if (!progressed) break;
  }
  return out;
}

/** Preserve first-appearance order while grouping — Map iterates by insertion. */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const existing = groups.get(key(item));
    if (existing) existing.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/**
 * One directory's emission order: round-robin over its files (each file ordered
 * by compareRanked, capped at `quota`), files themselves ordered by
 * compareRanked on their best candidate.
 */
function directoryStream(items: Ranked[], quota: number, limit: number): Ranked[] {
  const files = [...groupBy(items, (item) => item.snippet.filePath).values()];
  for (const file of files) {
    file.sort(compareRanked);
  }
  files.sort((a, b) => compareRanked(a[0]!, b[0]!));
  return interleave(
    files.map((file) => file.slice(0, quota)),
    limit
  );
}

interface DirTreeNode {
  children: Map<string, DirTreeNode>;
  /** The directory whose path ends exactly here, when it holds candidates. */
  self: string | null;
}

/**
 * Order every candidate-bearing directory by interleaving the package tree.
 *
 * A flat "sort directories by score" would tie-break on first appearance, i.e.
 * fall back to alphabetical for every repo whose cap is smaller than its
 * directory count (UniversalTweaks: 491 directories, cap 120) — the very bug
 * this module exists to fix. Interleaving instead alternates between sibling
 * packages at every depth, so a deep package is reached before a shallow one is
 * exhausted.
 *
 * Siblings are ordered by compareRanked on their stream *head* — the candidate
 * they would actually emit next. A max/sum over a subtree's scores saturates on
 * any package of more than a few dozen files and silently degenerates back to
 * first-appearance order.
 */
function orderDirectories(streams: Map<string, Ranked[]>): string[] {
  const root: DirTreeNode = { children: new Map(), self: null };
  for (const dir of streams.keys()) {
    let node = root;
    if (dir !== '') {
      for (const segment of dir.split('/')) {
        let child = node.children.get(segment);
        if (!child) {
          child = { children: new Map(), self: null };
          node.children.set(segment, child);
        }
        node = child;
      }
    }
    node.self = dir;
  }

  const headOf = (dirs: string[]): Ranked => streams.get(dirs[0]!)![0]!;
  const orderOf = (node: DirTreeNode): string[] => {
    const childOrders = [...node.children.values()].map(orderOf).filter((dirs) => dirs.length > 0);
    childOrders.sort((a, b) => compareRanked(headOf(a), headOf(b)));
    const own = node.self === null ? [] : [node.self];
    return own.concat(interleave(childOrders, Number.POSITIVE_INFINITY));
  };
  return orderOf(root);
}

/** Round-robin over directories in tree-interleaved order until `limit` is hit. */
function spread(ranked: Ranked[], limit: number, quota: number): Ranked[] {
  if (limit <= 0 || ranked.length === 0) {
    return [];
  }
  const streams = new Map<string, Ranked[]>();
  for (const [dir, items] of groupBy(ranked, (item) => dirOf(item.snippet.filePath))) {
    streams.set(dir, directoryStream(items, quota, limit));
  }
  const order = orderDirectories(streams);
  return interleave(
    order.map((dir) => streams.get(dir)!),
    limit
  );
}

/** What selectUnderCap kept, plus the shape of the choice (for the cap log). */
export interface CapSelection {
  /** The kept snippets, in ORIGINAL candidate order. */
  kept: Snippet[];
  /** Candidate files that contributed nothing, in first-appearance order. */
  starvedFiles: string[];
  keptFiles: number;
  totalFiles: number;
  keptDirs: number;
  candidateDirs: number;
  /** What plain head truncation would have reached — the before/after evidence. */
  headTruncationFiles: number;
  headTruncationDirs: number;
  markedKept: number;
  /** [marker, count] over the kept set, SELECTION_MARKERS order, zeros omitted. */
  markerCounts: Array<[string, number]>;
}

/**
 * Choose `cap` of `candidates`, spreading the budget across the package tree and
 * preferring category-bearing regions (DESIGN §6.2). Pure and deterministic:
 * the same candidates always yield the same set in the same order.
 *
 * Two passes. Pass 1 applies MAX_KEPT_PER_FILE_UNDER_CAP so a single 50-region
 * bootstrap class at a package root cannot claim a whole directory's share.
 * Pass 2 refills from the remainder without a quota, so a repo with few large
 * files still fills its cap instead of silently shrinking below it. Two passes
 * always suffice: an unquota'd pass yields min(deficit, remaining).
 */
export function selectUnderCap(candidates: Snippet[], cap: number): CapSelection {
  const ranked = rankCandidates(candidates);
  let picked = spread(ranked, cap, MAX_KEPT_PER_FILE_UNDER_CAP);
  if (picked.length < cap) {
    const taken = new Set(picked.map((item) => item.index));
    const rest = ranked.filter((item) => !taken.has(item.index));
    if (rest.length > 0) {
      picked = picked.concat(spread(rest, cap - picked.length, Number.POSITIVE_INFINITY));
    }
  }
  // Hard requirement: emit in original candidate order, whatever the strategy.
  picked.sort((a, b) => a.index - b.index);

  const keptPaths = new Set(picked.map((item) => item.snippet.filePath));
  const allPaths = [...new Set(candidates.map((s) => s.filePath))];
  const head = candidates.slice(0, cap);
  const markerCounts: Array<[string, number]> = [];
  for (const group of SELECTION_MARKERS) {
    const n = picked.filter((item) => item.markers.includes(group.name)).length;
    if (n > 0) markerCounts.push([group.name, n]);
  }
  return {
    kept: picked.map((item) => item.snippet),
    starvedFiles: allPaths.filter((p) => !keptPaths.has(p)),
    keptFiles: keptPaths.size,
    totalFiles: allPaths.length,
    keptDirs: new Set(picked.map((item) => dirOf(item.snippet.filePath))).size,
    candidateDirs: new Set(candidates.map((s) => dirOf(s.filePath))).size,
    headTruncationFiles: new Set(head.map((s) => s.filePath)).size,
    headTruncationDirs: new Set(head.map((s) => dirOf(s.filePath))).size,
    markedKept: picked.filter((item) => item.score > 0).length,
    markerCounts,
  };
}

/** `a, b, c (+N more)` — keeps a ~1000-path drop list out of the log. */
function listWithEllipsis(items: string[], max: number): string {
  if (items.length <= max) {
    return items.join(', ');
  }
  return `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
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

  // Enforce the per-repo snippet cap; log exactly what was dropped and how the
  // surviving budget is spread (DESIGN §3 "no silent caps", §6.2).
  if (cfg.maxSnippetsPerRepo !== null && candidates.length > cfg.maxSnippetsPerRepo) {
    const sel = selectUnderCap(candidates, cfg.maxSnippetsPerRepo);
    logger.log(
      `[${cfg.repo}] cap: keeping ${sel.kept.length}/${candidates.length} snippets ` +
        `(maxSnippetsPerRepo=${cfg.maxSnippetsPerRepo}); dropped ` +
        `${candidates.length - sel.kept.length} — ${sel.starvedFiles.length} of ` +
        `${sel.totalFiles} files contributed nothing: ` +
        listWithEllipsis(sel.starvedFiles, MAX_LOGGED_STARVED_FILES)
    );
    logger.log(
      `[${cfg.repo}] cap coverage: kept ${sel.kept.length} snippets from ` +
        `${sel.keptFiles}/${sel.totalFiles} files across ` +
        `${sel.keptDirs}/${sel.candidateDirs} directories (head truncation would have kept ` +
        `${sel.headTruncationFiles} files across ${sel.headTruncationDirs} directories); ` +
        `${sel.markedKept}/${sel.kept.length} kept snippets match a selection marker` +
        (sel.markerCounts.length === 0
          ? ''
          : ` — ${sel.markerCounts.map(([name, n]) => `${name} ${n}`).join(', ')}`)
    );
    return sel.kept;
  }

  return candidates;
}
