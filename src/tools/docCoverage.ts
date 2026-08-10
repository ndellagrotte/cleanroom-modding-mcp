/**
 * AI-facing coverage text for the documentation tools.
 *
 * `search_docs` used to close every response with the whole-corpus figure
 * ("Total documents indexed: 1432") regardless of the scope it ran under. At
 * the default target scope that number is 16x the truth, and the failure mode
 * it produced is specific: an agent gets two results, reads 1,432, concludes
 * the search is weak, and rephrases forever against a corpus that holds two
 * documents on the subject.
 *
 * So the point of this module is not prettier stats. It is to state the
 * *ceiling* — how many documents the active filter can reach — and to say
 * plainly when that ceiling has been hit, so retrying stops being tempting.
 *
 * Pure and exported for testing, the same shape as `formatCategoryTable` /
 * `formatEmptyModExampleSearch` in ./modExamples.ts. Nothing here reads a
 * database; example-corpus counts arrive as a parameter so `search_docs` never
 * takes a hard dependency on examples.db.
 */

import {
  docCategoryRouting,
  isDocCategory,
  type DocCategory,
  type ExampleCategory,
} from '../categories.js';
import { categoryCount, loaderLabel, type DocCoverage } from '../services/corpus-coverage.js';
import { TARGET_VERSION, type Scope } from '../loaders.js';

/** Live `search_mod_examples` counts, when examples.db is installed. */
export interface ExampleCounts {
  /** Examples per EXAMPLE_CATEGORIES slug. */
  byCategory: Partial<Record<ExampleCategory, number>>;
  /** Corpus size including uncategorized examples. */
  total: number;
}

export interface DocSearchRequest {
  query: string;
  scope: Scope;
  loader?: string;
  category?: string;
  minecraftVersion?: string;
  resultCount: number;
  /** The clamped limit, to tell "corpus exhausted" from "page full". */
  limit: number;
}

/** Below this, a result set is worth explaining rather than leaving bare. */
const FEW_RESULTS = 3;

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** "cleanroom 34, forge 54, shared 0" — zero counts included deliberately. */
function loaderBreakdown(coverage: DocCoverage): string {
  return coverage.loaders.map((l) => `${l.loader} ${l.count}`).join(', ');
}

/** "`target` (Cleanroom + Forge + Loader-agnostic)" or the explicit-loader form. */
function scopeLabel(coverage: DocCoverage): string {
  if (coverage.loader) {
    return `loader \`${coverage.loader}\` (${loaderLabel(coverage.loader)})`;
  }
  return `\`${coverage.scope}\``;
}

/**
 * Versions in scope, newest first and capped.
 *
 * The reference corpus spans 29 of them; listing all is noise in a footer, and
 * the newest few are what an agent picks from. Target scope has exactly one.
 */
function versionList(coverage: DocCoverage, limit = 6): string {
  if (coverage.versions.length === 0) {
    return 'none tagged';
  }
  const shown = coverage.versions.slice(0, limit).join(', ');
  return coverage.versions.length > limit
    ? `${shown} (+${coverage.versions.length - limit} older)`
    : shown;
}

/** The populated categories an agent could pivot to, biggest first. */
function bestCategories(coverage: DocCoverage, limit = 5): string {
  return coverage.categories
    .filter((c) => c.inEnum && c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((c) => `\`${c.category}\` (${c.count})`)
    .join(', ');
}

/**
 * The routing bullet for a doc category that came back empty.
 *
 * Counts are named when examples.db is installed, because a bare tool name does
 * not tell an agent whether the other corpus is any better stocked. With no
 * counts available we still route, just without the number.
 */
function exampleRouting(
  category: DocCategory,
  query: string,
  counts: ExampleCounts | undefined
): string {
  const routing = docCategoryRouting(category);

  if (routing.kind === 'examples') {
    const count = counts?.byCategory[routing.category];
    const suffix =
      count === undefined
        ? ''
        : count > 0
          ? ` — ${count} curated ${plural(count, 'example')} from real 1.12.2 mods`
          : ' (that category is empty there too — search it without `category`)';
    return `- \`search_mod_examples(query: "${query}", category: "${routing.category}")\`${suffix}\n`;
  }

  if (routing.kind === 'porting-tools') {
    // A corpus search is the wrong instrument here: the porting surface is
    // curated, target-scoped, and answers the question directly.
    return (
      `- \`find_equivalent(query: "${query}")\` — curated Fabric/NeoForge → Cleanroom mappings\n` +
      '- `get_porting_guide(guide: "porting-from-fabric" | "porting-from-neoforge" | "backporting")`\n'
    );
  }

  const suffix = counts ? ` — ${counts.total} curated examples from real 1.12.2 mods` : '';
  return `- \`search_mod_examples(query: "${query}")\`${suffix}\n`;
}

/**
 * The coverage footer, appended to every `search_docs` response.
 *
 * Order is deliberate: what this filter could reach, then the scope, then the
 * corpus. The old block inverted that and led with the number least connected
 * to the results on screen.
 */
export function formatDocCoverage(req: DocSearchRequest, coverage: DocCoverage): string {
  const filtered = Boolean(
    (req.category && req.category !== 'all') || req.minecraftVersion || req.loader
  );

  let out = '---\n**Search coverage:**\n';

  const filters = [
    `scope ${scopeLabel(coverage)}`,
    req.category && req.category !== 'all' ? `category \`${req.category}\`` : '',
    req.minecraftVersion ? `Minecraft \`${req.minecraftVersion}\`` : '',
  ].filter(Boolean);
  out += `- Query: "${req.query}" · ${filters.join(' · ')}\n`;
  out += `- Results returned: ${req.resultCount}\n`;

  // Only interesting when a narrowing filter is active; otherwise it restates
  // the scope line directly below it.
  if (filtered) {
    out += `- **Documents this filter can reach: ${coverage.inFilter}**\n`;
  }

  out += `- Scope ${scopeLabel(coverage)} holds **${coverage.inScope} ${plural(coverage.inScope, 'document')}** — ${loaderBreakdown(coverage)} · Minecraft ${versionList(coverage)}\n`;

  out += `- Whole docs corpus: ${coverage.corpusDocuments} documents`;
  if (coverage.outOfScope > 0) {
    const other =
      coverage.scope === 'target'
        ? '`reference` (Fabric/NeoForge, modern Minecraft)'
        : 'other scopes';
    out += `; the other ${coverage.outOfScope} are ${other} and excluded by design here`;
  }
  out += '.\n';

  const inScopeCategories = coverage.categories
    .filter((c) => c.inEnum && c.count > 0)
    .sort((a, b) => b.count - a.count);
  if (inScopeCategories.length > 0) {
    out += `- Categories in scope: ${inScopeCategories.map((c) => `${c.category} ${c.count}`).join(', ')}`;
    if (coverage.emptyCategories.length > 0) {
      out += ` · **0 documents:** ${coverage.emptyCategories.join(', ')}`;
    }
    out += '\n';
  }

  // The examples corpus reconciles its uncategorized bucket the same way
  // (see formatCategoryTable): a table that silently omits unreachable rows
  // reads as complete when it is not.
  if (coverage.offTaxonomy > 0) {
    out += `- ${coverage.offTaxonomy} in-scope documents sit in categories outside the \`category\` enum — reachable by free-text search, not by the filter\n`;
  }

  const closing = formatCeilingNote(req, coverage);
  if (closing) {
    out += `\n${closing}`;
  }

  return out;
}

/**
 * The line that ends the retry loop.
 *
 * When the result count already equals everything the filter can reach, saying
 * so is the whole fix: it converts "this search is weak" into "this corpus is
 * small", which are opposite instructions for what to do next.
 */
function formatCeilingNote(req: DocSearchRequest, coverage: DocCoverage): string {
  if (coverage.inFilter > 0 && req.resultCount >= coverage.inFilter) {
    return (
      `**All ${coverage.inFilter} ${plural(coverage.inFilter, 'document')} reachable under this filter ${plural(coverage.inFilter, 'was', 'were')} returned.** ` +
      'Rephrasing the query cannot surface more — widen the filter (drop `category`, or ' +
      '`scope: "all"`), or use `search_mod_examples` for 1.12.2 implementation patterns.\n'
    );
  }

  if (req.resultCount >= req.limit && coverage.inFilter > req.resultCount) {
    return (
      `**Result limit reached** (${req.limit} of ${coverage.inFilter} reachable documents). ` +
      'Raise `limit` for the rest.\n'
    );
  }

  return '';
}

/**
 * The explanation for an empty or thin result set — '' when nothing is wrong.
 *
 * Mirrors `formatEmptyModExampleSearch`: a category filter is the one argument
 * that can zero out the results no matter what else the agent does, so when one
 * is set the message reports that category's real count instead of the generic
 * "try broader search terms".
 */
export function formatDocSearchDiagnostics(
  req: DocSearchRequest,
  coverage: DocCoverage,
  exampleCounts?: ExampleCounts
): string {
  const category = req.category && req.category !== 'all' ? req.category : undefined;

  if (category && isDocCategory(category) && categoryCount(coverage, category) === 0) {
    return formatEmptyCategory(req, coverage, category, exampleCounts);
  }

  if (req.resultCount === 0) {
    return formatNoResults(req, coverage, exampleCounts);
  }

  if (req.resultCount < FEW_RESULTS && req.resultCount < coverage.inFilter) {
    return (
      `**${req.resultCount} of ${coverage.inFilter} reachable ${plural(coverage.inFilter, 'document')} scored above the relevance floor.** ` +
      '`get_doc_snippet` pulls the code blocks out of the pages above; `search_mod_examples` is ' +
      'the better source for a proven 1.12.2 implementation.\n\n'
    );
  }

  return '';
}

/** A category filter that can never match under this scope. */
function formatEmptyCategory(
  req: DocSearchRequest,
  coverage: DocCoverage,
  category: DocCategory,
  exampleCounts: ExampleCounts | undefined
): string {
  const routing = docCategoryRouting(category);
  const scope = scopeLabel(coverage);

  let out = `⚠️ **\`${category}\` holds 0 of the ${coverage.inScope} documents in scope ${scope}.**\n\n`;

  if (routing.kind === 'not-in-1.12.2') {
    // Reporting this as a corpus gap would be a lie by omission: no amount of
    // indexing will ever produce 1.12.2 documentation for something 1.12.2
    // does not have.
    out +=
      `That is not a corpus gap — ${routing.reason}. ` +
      `No phrasing of this query will find ${TARGET_VERSION} ${category} documentation, ` +
      'and none will ever exist.\n\n';
    out += '**Do this instead:**\n';
    out +=
      '- Ask for the hand-written form instead, e.g. `search_docs("blockstate json", category: "blocks")`\n';
    out += exampleRouting(category, req.query, exampleCounts);
    out += `- \`scope: "reference"\` documents this for modern Minecraft — porting input, not ${TARGET_VERSION} guidance\n\n`;
    return out;
  }

  out +=
    'Filtering by it at this scope can never return results, whatever the query — this is a gap ' +
    `in the scraped documentation, not evidence that ${TARGET_VERSION} lacks the API.\n\n`;
  out += '**Do this instead:**\n';
  out += exampleRouting(category, req.query, exampleCounts);
  const best = bestCategories(coverage);
  out += `- Re-run without \`category\`: ${coverage.inScope} documents are in scope`;
  out += best ? `, best covered ${best}\n` : '\n';
  if (coverage.scope === 'target') {
    out +=
      '- `scope: "reference"` returns Fabric/NeoForge material as porting input, not ' +
      `${TARGET_VERSION} guidance\n`;
  }
  out += '\n';
  return out;
}

/** Nothing matched, but the filter was not the reason. */
function formatNoResults(
  req: DocSearchRequest,
  coverage: DocCoverage,
  exampleCounts: ExampleCounts | undefined
): string {
  let out = `No documentation matched, though **${coverage.inScope} ${plural(coverage.inScope, 'document')} ${plural(coverage.inScope, 'is', 'are')} in scope** `;
  out += `(${scopeLabel(coverage)}: ${loaderBreakdown(coverage)}).\n\n`;

  if (coverage.scope === 'target') {
    out +=
      `The ${TARGET_VERSION} documentation corpus is small — ${coverage.inScope} documents against ` +
      `${coverage.corpusDocuments} indexed overall — so a miss here usually means the topic is ` +
      'undocumented, not that the query was wrong.\n\n';
  }

  out += '**Do this instead:**\n';
  out +=
    `- \`search_mod_examples("${req.query}")\`${exampleCounts ? ` — ${exampleCounts.total} curated examples,` : ' —'} ` +
    'code from real 1.12.2 mods, the primary source for implementation patterns\n';
  if (req.category && req.category !== 'all') {
    out += '- Drop `category` — it is a hard pre-filter, not a relevance boost\n';
  }
  out += `- \`explain_concept("${req.query}")\` for a synthesized overview\n`;
  if (coverage.scope === 'target') {
    out += '- `scope: "reference"` for Fabric/NeoForge porting material\n';
  }
  out += '\n';
  return out;
}

/**
 * One-line scope disclosure, for surfaces whose payload is code and must not be
 * crowded out by a full footer (`get_doc_snippet`).
 */
export function formatScopeLine(coverage: DocCoverage): string {
  const versions = coverage.versions.length > 0 ? `, Minecraft ${versionList(coverage, 3)}` : '';
  return (
    `Scope ${scopeLabel(coverage)}: **${coverage.inScope} of ${coverage.corpusDocuments} indexed documents** ` +
    `(${loaderBreakdown(coverage)}${versions}). This tool only returns what the documentation ` +
    'shows — for a real-mod implementation use `search_mod_examples`.'
  );
}
