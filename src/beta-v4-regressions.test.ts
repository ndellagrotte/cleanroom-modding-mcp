import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DBS } from './dbs.js';
import type { DbId } from './dbs.js';
import type { handleSearchDocs as HandleSearchDocs } from './tools/searchDocs.js';
import type { handleExplainConcept as HandleExplainConcept } from './tools/explainConcept.js';
import type { handleGetClassDetails as HandleGetClassDetails } from './tools/mappings.js';

/**
 * End-to-end regression gates for the exact beta v4 reproductions.
 *
 * The generated databases are release artifacts and are intentionally not
 * checked into git. Match the existing corpus-integration convention: run these
 * assertions whenever the docs and mappings data/ files are present, and skip them on
 * source-only CI workers. scripts/index-docs.ts and scripts/release.ts own the
 * mandatory generated-corpus gate.
 */

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');

function hasCurrentDatabase(id: DbId): boolean {
  const dbPath = path.join(DATA_DIR, DBS[id].fileName);
  if (!fs.existsSync(dbPath)) return false;

  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      return row?.value === String(DBS[id].schemaVersion);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

const HAS_DOCS = hasCurrentDatabase('docs');
const HAS_MAPPINGS = hasCurrentDatabase('mappings');
const describeGenerated = HAS_DOCS && HAS_MAPPINGS ? describe : describe.skip;

let savedDataDir: string | undefined;
let handleSearchDocs: typeof HandleSearchDocs;
let handleExplainConcept: typeof HandleExplainConcept;
let handleGetClassDetails: typeof HandleGetClassDetails;

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? '').join('\n');
}

describeGenerated('beta v4 exact reproductions', () => {
  beforeAll(async () => {
    savedDataDir = process.env.CLEANROOM_MCP_DATA_DIR;
    process.env.CLEANROOM_MCP_DATA_DIR = DATA_DIR;
    vi.resetModules();
    const [docsTools, conceptTools, mappingTools] = await Promise.all([
      import('./tools/searchDocs.js'),
      import('./tools/explainConcept.js'),
      import('./tools/mappings.js'),
    ]);
    handleSearchDocs = docsTools.handleSearchDocs;
    handleExplainConcept = conceptTools.handleExplainConcept;
    handleGetClassDetails = mappingTools.handleGetClassDetails;
  });

  afterAll(() => {
    if (savedDataDir === undefined) {
      delete process.env.CLEANROOM_MCP_DATA_DIR;
    } else {
      process.env.CLEANROOM_MCP_DATA_DIR = savedDataDir;
    }
  });

  it('search_docs("how to register items", category="items") returns an intact second summary', async () => {
    const output = text(
      await handleSearchDocs({
        query: 'how to register items',
        category: 'items',
      })
    );

    expect(output).not.toContain('ot entry:');
    expect(output).toMatch(
      /## 2\.[\s\S]*\*\*Summary:\*\*\s+In addition to vanilla's, you can also register/i
    );
  });

  it('explain_concept("capabilities") uses the overview lead without duplicate or truncated prose', async () => {
    const output = text(await handleExplainConcept({ concept: 'capabilities' }));

    expect(output).toMatch(
      /## Summary\s+Capabilities allow exposing features in a dynamic and flexible way/i
    );
    expect(output).not.toContain('on of the capability');
    expect(output.match(/\*\*Forge-provided Capabilities:\*\*/g) ?? []).toHaveLength(1);
  });

  it('get_class_details discloses modern field availability', () => {
    const output = text(
      handleGetClassDetails({
        class_name: 'net.minecraft.world.level.block.Block',
        minecraft_version: '1.21.4',
      })
    );

    expect(output).toMatch(
      /## Fields \(\d+\)|fields? (?:are |is )?(?:not |un)available|No fields with mappings found/i
    );
  });
});
