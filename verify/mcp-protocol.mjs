// verify/mcp-protocol.mjs   — run: node verify/mcp-protocol.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';

const REPO = process.env.REPO ?? process.cwd();
const ENTRY = process.env.SERVER_ENTRY ?? `${REPO}/dist/index.js`;
const FROM_VOCABS = ['fabric', 'neoforge', 'modern-minecraft'];
const TEMPLATE_COMPONENTS = ['build.gradle', 'gradle.properties', 'settings.gradle', 'mcmod.info', 'ExampleMod.java', 'mixins.json', 'modid_at.cfg', 'README', 'checklist'];
const GUIDES = ['porting-from-fabric', 'porting-from-neoforge', 'backporting', 'mixin-setup'];
const PROMPTS = { scaffold_cleanroom_mod: ['mod_id'], port_mod_to_cleanroom: ['source_loader'], backport_feature: ['source_version'] };

let failed = 0;
const ok = (m) => console.log('PASS:', m);
const bad = (m, e) => { console.log('FAIL:', m, e?.message ?? e ?? ''); failed = 1; };
const check = async (m, fn) => { try { await fn(); ok(m); } catch (e) { bad(m, e); } };

async function connect(docsDb) {
  const client = new Client({ name: 'blind-oracle', version: '0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: 'node', args: [ENTRY],
    env: { ...process.env, CLEANROOM_MCP_SKIP_AUTO_UPDATE: '1', ...(docsDb ? { DOCS_DB: docsDb } : {}) },
  });
  await client.connect(transport);
  return { client, transport };
}
const textOf = (res) => (res?.content ?? res?.messages?.flatMap((m) => [m.content]) ?? [])
  .map((c) => (c?.type === 'text' ? c.text : (c?.resource?.text ?? ''))).join('\n');

async function main() {
  const primaryDb = process.env.DOCS_DB;
  const v1Db = process.env.DOCS_DB_V1;

  let { client, transport } = await connect(primaryDb);
  const caps = client.getServerCapabilities();
  await check('capabilities include resources', async () => assert.ok(caps?.resources));
  await check('capabilities include prompts (C1)', async () => assert.ok(caps?.prompts));
  await check('no resources.subscribe', async () => assert.notEqual(caps?.resources?.subscribe, true));

  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['find_equivalent', 'get_project_template', 'get_porting_guide', 'list_targets'])
    await check(`tool listed: ${t}`, async () => assert.ok(tools.includes(t)));

  await check('find_equivalent.from enum == 3 from-vocabs', async () => {
    const fe = (await client.listTools()).tools.find((t) => t.name === 'find_equivalent');
    const en = fe.inputSchema?.properties?.from?.enum ?? [];
    assert.deepEqual([...en].sort(), [...FROM_VOCABS].sort());
  });

  const resUris = (await client.listResources()).resources.map((r) => r.uri);
  for (const c of TEMPLATE_COMPONENTS)
    await check(`resource enumerated: template/${c}`, async () => assert.ok(resUris.includes(`cleanroom://template/${c}`)));
  for (const g of GUIDES)
    await check(`resource enumerated: guide/${g}`, async () => assert.ok(resUris.includes(`cleanroom://guide/${g}`)));

  await check('ReadResource unknown -> -32002', async () => {
    try { await client.readResource({ uri: 'cleanroom://template/does-not-exist' }); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, -32002); }
  });

  for (const c of TEMPLATE_COMPONENTS) {
    await check(`byte-parity template/${c}`, async () => {
      const r = await client.readResource({ uri: `cleanroom://template/${c}` });
      const rBody = r.contents.map((x) => x.text ?? '').join('');
      const t = await client.callTool({ name: 'get_project_template', arguments: { component: c } });
      assert.equal(textOf(t).trim(), rBody.trim());
    });
  }
  for (const g of GUIDES) {
    await check(`byte-parity guide/${g}`, async () => {
      const r = await client.readResource({ uri: `cleanroom://guide/${g}` });
      const rBody = r.contents.map((x) => x.text ?? '').join('');
      const t = await client.callTool({ name: 'get_porting_guide', arguments: { name: g } });
      assert.equal(textOf(t).trim(), rBody.trim());
    });
  }

  const promptNames = (await client.listPrompts()).prompts.map((p) => p.name);
  for (const p of Object.keys(PROMPTS))
    await check(`prompt listed: ${p}`, async () => assert.ok(promptNames.includes(p)));

  await check('scaffold_cleanroom_mod embeds template/checklist resource', async () => {
    const r = await client.getPrompt({ name: 'scaffold_cleanroom_mod', arguments: { mod_id: 'demo' } });
    const embeds = r.messages.some((m) => m.content?.type === 'resource' && String(m.content?.resource?.uri || '').includes('cleanroom://template/checklist'));
    assert.ok(embeds, 'no embedded checklist resource');
  });
  await check('port_mod_to_cleanroom embeds porting-from-fabric guide', async () => {
    const r = await client.getPrompt({ name: 'port_mod_to_cleanroom', arguments: { source_loader: 'fabric' } });
    const embeds = r.messages.some((m) => String(m.content?.resource?.uri || '').includes('cleanroom://guide/porting-from-fabric'));
    assert.ok(embeds);
  });
  await check('backport_feature embeds backporting guide', async () => {
    const r = await client.getPrompt({ name: 'backport_feature', arguments: { source_version: '1.21' } });
    const embeds = r.messages.some((m) => String(m.content?.resource?.uri || '').includes('cleanroom://guide/backporting'));
    assert.ok(embeds);
  });
  await check('GetPrompt unknown name -> -32602', async () => {
    try { await client.getPrompt({ name: '__nope__', arguments: {} }); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, -32602); }
  });
  await check('GetPrompt missing required arg -> -32602', async () => {
    try { await client.getPrompt({ name: 'scaffold_cleanroom_mod', arguments: {} }); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, -32602); }
  });

  await check('list_targets reports prompts+resources+templates+equivalence', async () => {
    const t = textOf(await client.callTool({ name: 'list_targets', arguments: {} })).toLowerCase();
    for (const kw of ['prompt', 'resource', 'template', 'equivalen'])
      assert.ok(t.includes(kw), `list_targets omits "${kw}"`);
  });
  await check('list_targets does not present modern-minecraft as a loader', async () => {
    const t = textOf(await client.callTool({ name: 'list_targets', arguments: {} }));
    const badRow = /loader[^\n]*modern-minecraft/i.test(t);
    assert.ok(!badRow, 'modern-minecraft appears as a loader target');
  });

  const feHits = (out) => (out.match(/^### /gm) || []).length;
  await check('find_equivalent clamps limit=999 to <=50', async () => {
    const out = textOf(await client.callTool({ name: 'find_equivalent', arguments: { query: 'net', from: 'fabric', limit: 999 } }));
    assert.ok(feHits(out) <= 50);
  });
  await check('find_equivalent limit=0 -> >=1 effective (never 0-cap error)', async () => {
    const r = await client.callTool({ name: 'find_equivalent', arguments: { query: 'net', from: 'fabric', limit: 0 } });
    assert.notEqual(r.isError, true);
  });
  await check('find_equivalent default header shape', async () => {
    const out = textOf(await client.callTool({ name: 'find_equivalent', arguments: { query: 'registry', from: 'fabric' } }));
    assert.match(out, /Found \d+ equivalents?/);
    assert.ok(feHits(out) <= 15);
  });

  await check('P-HIT sample: each from_api is retrievable', async () => {
    const { execSync } = await import('node:child_process');
    let rows;
    try { rows = execSync(`sqlite3 -json "${primaryDb}" "SELECT from_vocab,from_api,kind FROM equivalence ORDER BY id LIMIT 25;"`).toString(); }
    catch { console.log('   (sqlite3 CLI unavailable — P-HIT sample skipped)'); return; }
    for (const { from_vocab, from_api, kind } of JSON.parse(rows || '[]')) {
      const out = textOf(await client.callTool({ name: 'find_equivalent', arguments: { query: from_api, from: from_vocab } }));
      assert.ok(out.includes(from_api.slice(0, Math.min(24, from_api.length))), `not retrievable: ${from_api}`);
      if (kind === 'missing') assert.ok(/No 1\.12\.2 equivalent/i.test(out), `missing not honest: ${from_api}`);
    }
  });

  await transport.close();

  if (v1Db) {
    ({ client, transport } = await connect(v1Db));
    await check('find_equivalent still LISTED on v1 db', async () => {
      const t = (await client.listTools()).tools.map((x) => x.name); assert.ok(t.includes('find_equivalent'));
    });
    await check('find_equivalent degrades gracefully on v1 db', async () => {
      const r = await client.callTool({ name: 'find_equivalent', arguments: { query: 'x', from: 'fabric' } });
      assert.notEqual(r.isError, true);
      const out = textOf(r);
      assert.match(out, /isn't present|isn.t present/i);
      assert.match(out, /manage/i);
    });
    await transport.close();
  } else {
    console.log('NOTE: DOCS_DB_V1 unset — P-DEGRADE skipped. Build it with verify/make-v1-db.sh and re-run.');
  }

  console.log(failed ? 'PROTOCOL ORACLE RED' : 'PROTOCOL ORACLE GREEN');
  process.exit(failed);
}
main().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
