/**
 * Pass 2 of the Cleanroom API indexing pipeline: corpus-wide name resolution
 * and derived catalogs.
 *
 * Takes every ExtractedFile from pass 1 and produces flat ResolvedType rows:
 *   - dotted FQNs with outer_fqn nesting links
 *   - extends/implements resolved to corpus FQNs where possible (external
 *     parents — JDK, vanilla net.minecraft.*, libraries — stay raw-only)
 *   - the events catalog: transitive subclasses of
 *     net.minecraftforge.fml.common.eventhandler.Event, with inherited
 *     @Cancelable / @HasResult flags (matching Forge's runtime hasAnnotation
 *     walk up the superclass chain)
 *   - usage counts for corpus-defined annotations
 */

import type { Loader } from '../loaders.js';
import { stripTypeArgs } from './extract.js';
import type {
  ExtractedFile,
  ExtractedType,
  ImportMap,
  ResolveResult,
  ResolveStats,
  ResolvedType,
} from './model.js';

export const EVENT_BASE_FQN = 'net.minecraftforge.fml.common.eventhandler.Event';
export const CANCELABLE_FQN = 'net.minecraftforge.fml.common.eventhandler.Cancelable';
export const HAS_RESULT_FQN = 'net.minecraftforge.fml.common.eventhandler.Event.HasResult';

/** Namespace -> loader attribution (informational; DESIGN.md §5.1). */
export function loaderForPackage(packageName: string): Loader {
  if (packageName.startsWith('com.cleanroommc') || packageName.startsWith('zone.rong')) {
    return 'cleanroom';
  }
  return 'forge';
}

interface ResolutionContext {
  packageName: string;
  imports: ImportMap;
  /** Enclosing-type FQNs, innermost first; empty for top-level types. */
  enclosingFqns: string[];
}

/**
 * Resolve a raw type reference to a corpus FQN, or null when the name points
 * outside the corpus. Follows Java's precedence: enclosing types, explicit
 * imports, same package, wildcard imports. An explicit import that points
 * outside the corpus terminates resolution (Java semantics: explicit imports
 * win over same-package and wildcards... except that a same-package declaration
 * actually shadows nothing here because javac forbids importing a colliding
 * name — the corpus compiled, so the order below is safe).
 */
export function resolveName(
  raw: string,
  ctx: ResolutionContext,
  byFqn: ReadonlySet<string>
): string | null {
  const clean = stripTypeArgs(raw);
  if (!clean || /[^A-Za-z0-9_.$]/.test(clean)) {
    return null;
  }

  const resolveSimple = (simple: string): string | null => {
    // Self or enclosing type (innermost wins).
    for (const enclosing of ctx.enclosingFqns) {
      if (enclosing.endsWith(`.${simple}`) || enclosing === simple) {
        return enclosing;
      }
      // Sibling/nested types visible through an enclosing scope.
      const nested = `${enclosing}.${simple}`;
      if (byFqn.has(nested)) {
        return nested;
      }
    }
    const imported = ctx.imports.explicit[simple];
    if (imported) {
      return byFqn.has(imported) ? imported : null;
    }
    const samePackage = `${ctx.packageName}.${simple}`;
    if (byFqn.has(samePackage)) {
      return samePackage;
    }
    for (const wildcard of ctx.imports.wildcards) {
      const candidate = `${wildcard}.${simple}`;
      if (byFqn.has(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  if (clean.includes('.')) {
    // Already qualified relative to the corpus?
    if (byFqn.has(clean)) {
      return clean;
    }
    // Qualified via a resolvable head: 'Mod.EventBusSubscriber', 'Event.HasResult'.
    const [head, ...rest] = clean.split('.');
    const headFqn = resolveSimple(head ?? '');
    if (headFqn) {
      const candidate = `${headFqn}.${rest.join('.')}`;
      if (byFqn.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  return resolveSimple(clean);
}

interface FlattenedEntry {
  resolved: ResolvedType;
  ctx: ResolutionContext;
  extracted: ExtractedType;
}

function flatten(
  file: ExtractedFile,
  type: ExtractedType,
  enclosingFqns: string[],
  out: FlattenedEntry[]
): void {
  const fqn = `${file.packageName}.${type.nestedChain.join('.')}`;
  const outerFqn = enclosingFqns[0] ?? null;
  const resolved: ResolvedType = {
    fqn,
    simpleName: type.simpleName,
    packageName: file.packageName,
    outerFqn,
    kind: type.kind,
    loader: loaderForPackage(file.packageName),
    modifiers: type.modifiers.join(' '),
    signature: type.signature,
    extendsRaw: type.extendsRaw,
    extendsFqn: null, // filled in after the corpus set is complete
    implementsRaw: type.implementsRaw,
    implementsFqns: [],
    annotations: type.annotations,
    javadoc: type.javadoc?.body || null,
    javadocSummary: type.javadoc?.summary || null,
    isDeprecated: type.isDeprecated,
    deprecationNote: type.javadoc?.deprecatedNote ?? null,
    since: type.since,
    isEvent: false,
    isCancelable: false,
    hasResult: false,
    sourceFile: file.path,
    searchText: type.searchText,
    members: type.members,
    nestingDepth: enclosingFqns.length,
  };
  out.push({
    resolved,
    ctx: {
      packageName: file.packageName,
      imports: file.imports,
      enclosingFqns: [fqn, ...enclosingFqns],
    },
    extracted: type,
  });
  for (const child of type.children) {
    flatten(file, child, [fqn, ...enclosingFqns], out);
  }
}

/**
 * Does an annotation reference match a target corpus annotation? Accepts a
 * resolved-FQN match, or — when the reference is unresolvable — a bare
 * last-segment match. The fallback covers nested annotations made visible by
 * inheritance (e.g. '@HasResult' inside a subclass of Event, which plain
 * lexical-scope resolution cannot see).
 */
function annotationMatches(
  rawName: string,
  ctx: ResolutionContext,
  byFqn: ReadonlySet<string>,
  targetFqn: string
): boolean {
  const resolved = resolveName(rawName, ctx, byFqn);
  if (resolved) {
    return resolved === targetFqn;
  }
  const lastSegment = rawName.split('.').pop();
  return lastSegment === targetFqn.split('.').pop();
}

/** Resolve all files into flat rows plus the derived catalogs. */
export function resolveAll(files: ExtractedFile[]): ResolveResult {
  const entries: FlattenedEntry[] = [];
  for (const file of files) {
    for (const type of file.types) {
      flatten(file, type, [], entries);
    }
  }

  // Duplicate FQNs would violate the UNIQUE constraint at ingest; keep the
  // first occurrence (duplicates in a sources jar indicate packaging noise).
  const byFqnMap = new Map<string, FlattenedEntry>();
  for (const entry of entries) {
    if (!byFqnMap.has(entry.resolved.fqn)) {
      byFqnMap.set(entry.resolved.fqn, entry);
    }
  }
  const unique = [...byFqnMap.values()];
  const fqnSet = new Set(byFqnMap.keys());

  // Resolve extends/implements now that the full corpus is known. Extends
  // edges first: the second-chance pass below walks them (and the implements
  // edges), so both passes must complete before it runs.
  for (const entry of unique) {
    if (entry.resolved.extendsRaw) {
      entry.resolved.extendsFqn = resolveName(entry.resolved.extendsRaw, entry.ctx, fqnSet);
    }
  }
  for (const entry of unique) {
    entry.resolved.implementsFqns = entry.resolved.implementsRaw
      .map((raw) => resolveName(raw, entry.ctx, fqnSet))
      .filter((f): f is string => f !== null);
  }

  // Second chance (JLS 6.3): member types INHERITED by an enclosing type are
  // in scope throughout its body, so 'implements Builder' can refer to a
  // superinterface's nested Builder that lexical resolution cannot see.
  const ancestorCache = new Map<string, string[]>();
  const ancestorsOf = (fqn: string): string[] => {
    const cached = ancestorCache.get(fqn);
    if (cached) {
      return cached;
    }
    const closure: string[] = [];
    ancestorCache.set(fqn, closure);
    const seen = new Set([fqn]);
    const queue = [fqn];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      const entry = byFqnMap.get(current);
      if (!entry) {
        continue;
      }
      for (const parent of [entry.resolved.extendsFqn, ...entry.resolved.implementsFqns]) {
        if (parent && !seen.has(parent)) {
          seen.add(parent);
          closure.push(parent);
          queue.push(parent);
        }
      }
    }
    return closure;
  };
  const resolveInheritedMember = (raw: string, ctx: ResolutionContext): string | null => {
    const clean = stripTypeArgs(raw);
    if (!clean || clean.includes('.') || /[^A-Za-z0-9_$]/.test(clean)) {
      return null;
    }
    // Skip the type itself (index 0): its own inherited member types are in
    // scope inside its body, but NOT in its extends/implements clauses (javac
    // rejects those) — only the enclosing types' hierarchies count.
    for (const enclosing of ctx.enclosingFqns.slice(1)) {
      for (const ancestor of ancestorsOf(enclosing)) {
        const candidate = `${ancestor}.${clean}`;
        if (fqnSet.has(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  };
  // Iterate to a fixpoint: one entry's second-chance edge can be the path by
  // which another entry's clause resolves, and the ancestor cache freezes
  // closures — repeat until stable so the result is iteration-order
  // independent.
  for (;;) {
    let changed = false;
    ancestorCache.clear();
    for (const entry of unique) {
      const { resolved, ctx } = entry;
      if (resolved.extendsRaw && !resolved.extendsFqn) {
        resolved.extendsFqn = resolveInheritedMember(resolved.extendsRaw, ctx);
        if (resolved.extendsFqn) {
          changed = true;
        }
      }
      if (resolved.implementsRaw.length > resolved.implementsFqns.length) {
        const before = resolved.implementsFqns.length;
        resolved.implementsFqns = resolved.implementsRaw
          .map((raw) => resolveName(raw, ctx, fqnSet) ?? resolveInheritedMember(raw, ctx))
          .filter((f): f is string => f !== null);
        if (resolved.implementsFqns.length > before) {
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }

  let resolvedParents = 0;
  let unresolvedParents = 0;
  for (const entry of unique) {
    if (entry.resolved.extendsRaw) {
      if (entry.resolved.extendsFqn) {
        resolvedParents++;
      } else {
        unresolvedParents++;
      }
    }
  }

  // Events catalog: BFS over reverse extends edges from the Event base class.
  const childrenByParent = new Map<string, string[]>();
  for (const entry of unique) {
    const parent = entry.resolved.extendsFqn;
    if (parent && entry.resolved.kind === 'class') {
      const list = childrenByParent.get(parent) ?? [];
      list.push(entry.resolved.fqn);
      childrenByParent.set(parent, list);
    }
  }
  if (fqnSet.has(EVENT_BASE_FQN)) {
    const queue = [EVENT_BASE_FQN];
    while (queue.length > 0) {
      const fqn = queue.shift();
      if (!fqn) {
        break;
      }
      const entry = byFqnMap.get(fqn);
      if (!entry || entry.resolved.isEvent) {
        continue;
      }
      entry.resolved.isEvent = true;
      queue.push(...(childrenByParent.get(fqn) ?? []));
    }
  }

  // Inherited @Cancelable / @HasResult: walk self + corpus ancestors, matching
  // Forge's Event.hasAnnotation() superclass walk.
  for (const entry of unique) {
    if (!entry.resolved.isEvent) {
      continue;
    }
    let cancelable = false;
    let hasResult = false;
    let cursor: FlattenedEntry | undefined = entry;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.resolved.fqn)) {
      seen.add(cursor.resolved.fqn);
      for (const rawName of cursor.resolved.annotations) {
        cancelable ||= annotationMatches(rawName, cursor.ctx, fqnSet, CANCELABLE_FQN);
        hasResult ||= annotationMatches(rawName, cursor.ctx, fqnSet, HAS_RESULT_FQN);
      }
      cursor = cursor.resolved.extendsFqn ? byFqnMap.get(cursor.resolved.extendsFqn) : undefined;
    }
    entry.resolved.isCancelable = cancelable;
    entry.resolved.hasResult = hasResult;
  }

  // Usage counts for corpus-defined annotations, across type + member declarations.
  const annotationUsage = new Map<string, number>();
  const countUsage = (rawName: string, ctx: ResolutionContext): void => {
    const resolved = resolveName(rawName, ctx, fqnSet);
    if (resolved && byFqnMap.get(resolved)?.resolved.kind === 'annotation') {
      annotationUsage.set(resolved, (annotationUsage.get(resolved) ?? 0) + 1);
    }
  };
  for (const entry of unique) {
    for (const rawName of entry.resolved.annotations) {
      countUsage(rawName, entry.ctx);
    }
    for (const member of entry.resolved.members) {
      for (const rawName of member.annotations) {
        countUsage(rawName, entry.ctx);
      }
    }
  }

  const types = unique.map((e) => e.resolved);
  const stats: ResolveStats = {
    totalTypes: types.length,
    totalMembers: types.reduce((sum, t) => sum + t.members.length, 0),
    resolvedParents,
    unresolvedParents,
    events: types.filter((t) => t.isEvent).length,
    annotationTypes: types.filter((t) => t.kind === 'annotation').length,
  };

  return { types, annotationUsage, stats };
}
