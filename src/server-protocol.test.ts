import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DocumentStore } from './indexer/store.js';
import { compileEquivalence } from '../scripts/equivalence-compile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const ENTRY = path.join(REPO, 'dist', 'index.js');
const DIST_OK = fs.existsSync(ENTRY);

const TEMPLATE_COMPONENTS = [
  'build.gradle',
  'gradle.properties',
  'settings.gradle',
  'mcmod.info',
  'ExampleMod.java',
  'mixins.json',
  'modid_at.cfg',
  'README',
  'checklist',
];
const GUIDES = ['porting-from-fabric', 'porting-from-neoforge', 'backporting', 'mixin-setup'];
const PROMPTS = ['scaffold_cleanroom_mod', 'port_mod_to_cleanroom', 'backport_feature'];

interface ContentItem {
  type?: string;
  text?: string;
  resource?: { text?: string; uri?: string };
}
interface ToolResult {
  content?: ContentItem[];
  isError?: boolean;
}
interface ResourceContents {
  contents: Array<{ text?: string; uri?: string }>;
}
interface PromptMessage {
  role: string;
  content?: ContentItem;
}

const textOf = (res: ToolResult): string =>
  (res.content ?? [])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : (c.resource?.text ?? '')))
    .join('\n');

async function connect(docsDb: string) {
  const client = new Client({ name: 'proto-test', version: '0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [ENTRY],
    env: { ...process.env, DOCS_DB: docsDb, CLEANROOM_MCP_SKIP_AUTO_UPDATE: '1' },
  });
  await client.connect(transport);
  return { client, transport };
}

describe.runIf(DIST_OK)('MCP server protocol (spawned stdio)', () => {
  let tempDir: string;
  let v2Db: string;
  let v1Db: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-'));
    v2Db = path.join(tempDir, 'docs_v2.db');
    v1Db = path.join(tempDir, 'docs_v1.db');
    const store = new DocumentStore(v2Db);
    store.stampSchemaVersion();
    const { entries } = await compileEquivalence(path.join(REPO, 'data', 'equivalence'));
    store.replaceEquivalence(entries);
    store.close();
    // v1 degrade fixture
    fs.copyFileSync(v2Db, v1Db);
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(v1Db);
    raw.exec('DROP TABLE IF EXISTS equivalence_fts; DROP TABLE IF EXISTS equivalence;');
    raw.prepare("UPDATE metadata SET value='1' WHERE key='schema_version'").run();
    raw.close();
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('declares prompts + resources capabilities', async () => {
    const { client, transport } = await connect(v2Db);
    const caps = client.getServerCapabilities();
    expect(caps?.prompts).toBeTruthy();
    expect(caps?.resources).toBeTruthy();
    expect(caps?.resources?.subscribe).not.toBe(true);
    await transport.close();
  });

  it('lists the always-on Phase 4 tools', async () => {
    const { client, transport } = await connect(v2Db);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of [
      'find_equivalent',
      'get_project_template',
      'get_porting_guide',
      'list_targets',
    ]) {
      expect(tools).toContain(t);
    }
    const fe = (await client.listTools()).tools.find((t) => t.name === 'find_equivalent')!;
    const schema = fe.inputSchema as { properties: { from: { enum: string[] } } };
    expect([...schema.properties.from.enum].sort()).toEqual([
      'fabric',
      'modern-minecraft',
      'neoforge',
    ]);
    await transport.close();
  });

  it('discloses that `general` is a fallback bucket, not a subject area', async () => {
    const { client, transport } = await connect(v2Db);
    const tools = (await client.listTools()).tools;

    // `general` holds ~32% of the target corpus and ~50% of the whole index because
    // it is where extractCategoryFromUrl lands when no path segment names a topic.
    // An agent that reads it as a subject and filters by it excludes every
    // categorized page while narrowing nothing, so saying so is part of the schema.
    for (const name of ['search_docs', 'get_doc_snippet']) {
      const tool = tools.find((t) => t.name === name)!;
      const category = tool.inputSchema.properties?.['category'] as
        | { description?: string }
        | undefined;
      const description = category?.description;
      expect(description, name).toMatch(/fallback/i);
      expect(description, name).toContain('general');
    }

    await transport.close();
  });

  it('lists get_doc_snippet, not get_example, and cross-links search_mod_examples', async () => {
    const { client, transport } = await connect(v2Db);
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);

    expect(names).toContain('get_doc_snippet');
    expect(names).not.toContain('get_example');

    // The description is what routes an agent to the curated corpus (red-team finding N1),
    // so it is part of the contract, not decoration.
    const snippet = tools.find((t) => t.name === 'get_doc_snippet')!;
    expect(snippet.description).toMatch(/documentation/i);
    expect(snippet.description).toMatch(/search_mod_examples/);

    // The pre-2.2.0 name stays dispatchable as an unlisted alias. Asserting it *resolves* is
    // the routing check: an unknown tool rejects (index.ts throws), whereas a handler with no
    // usable database resolves with isError — which of those happens here depends on the host.
    await expect(
      client.callTool({ name: 'get_example', arguments: { topic: 'test' } })
    ).resolves.toBeDefined();

    await transport.close();
  });

  it('enumerates concrete resources and returns -32002 for unknown', async () => {
    const { client, transport } = await connect(v2Db);
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    for (const c of TEMPLATE_COMPONENTS) expect(uris).toContain(`cleanroom://template/${c}`);
    for (const g of GUIDES) expect(uris).toContain(`cleanroom://guide/${g}`);
    await expect(client.readResource({ uri: 'cleanroom://template/nope' })).rejects.toMatchObject({
      code: -32002,
    });
    await transport.close();
  });

  it('resource bodies are byte-identical to their tool twins', async () => {
    const { client, transport } = await connect(v2Db);
    for (const c of TEMPLATE_COMPONENTS) {
      const r = await client.readResource({ uri: `cleanroom://template/${c}` });
      const rBody = (r as ResourceContents).contents.map((x) => x.text ?? '').join('');
      const t = await client.callTool({
        name: 'get_project_template',
        arguments: { component: c },
      });
      expect(textOf(t).trim()).toBe(rBody.trim());
    }
    for (const g of GUIDES) {
      const r = await client.readResource({ uri: `cleanroom://guide/${g}` });
      const rBody = (r as ResourceContents).contents.map((x) => x.text ?? '').join('');
      const t = await client.callTool({ name: 'get_porting_guide', arguments: { name: g } });
      expect(textOf(t).trim()).toBe(rBody.trim());
    }
    await transport.close();
  });

  it('resolves prompts with embedded resources; -32602 on bad input', async () => {
    const { client, transport } = await connect(v2Db);
    const names = (await client.listPrompts()).prompts.map((p) => p.name);
    for (const p of PROMPTS) expect(names).toContain(p);

    const scaffold = await client.getPrompt({
      name: 'scaffold_cleanroom_mod',
      arguments: { mod_id: 'demo' },
    });
    expect(
      (scaffold.messages as PromptMessage[]).some(
        (m) =>
          m.content?.type === 'resource' &&
          String(m.content?.resource?.uri).includes('cleanroom://template/checklist')
      )
    ).toBe(true);

    await expect(client.getPrompt({ name: '__nope__', arguments: {} })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      client.getPrompt({ name: 'scaffold_cleanroom_mod', arguments: {} })
    ).rejects.toMatchObject({ code: -32602 });
    await transport.close();
  });

  it('find_equivalent hits on v2 and degrades on v1', async () => {
    const c1 = await connect(v2Db);
    const hit = textOf(
      await c1.client.callTool({
        name: 'find_equivalent',
        arguments: { query: 'ServerPlayNetworking.registerGlobalReceiver', from: 'fabric' },
      })
    );
    expect(hit).toMatch(/Found \d+ equivalent/);
    expect((hit.match(/^### /gm) || []).length).toBeGreaterThanOrEqual(1);
    await c1.transport.close();

    const c2 = await connect(v1Db);
    const listed = (await c2.client.listTools()).tools.map((t) => t.name);
    expect(listed).toContain('find_equivalent');
    const degrade = await c2.client.callTool({
      name: 'find_equivalent',
      arguments: { query: 'x', from: 'fabric' },
    });
    expect(degrade.isError).not.toBe(true);
    const out = textOf(degrade);
    expect(out).toMatch(/isn't present/i);
    expect(out).toMatch(/manage/i);
    await c2.transport.close();
  });
});
