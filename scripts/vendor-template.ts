#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Vendor CleanroomModTemplate snapshots into committed src/templates/*.ts modules.
 *
 * Maintainer / CI tool — NOT shipped in the npm tarball (package.json "files" is dist +
 * postinstall only). It fetches the pinned template files verbatim (blossom `{{ }}` tokens
 * intact — Fixed Input 4), records per-branch commit SHAs in data/templates-pins.json, and
 * writes one `export default` string module per component. src/templates/index.ts and
 * src/templates/checklist.ts are hand-authored and NOT regenerated here.
 *
 * Usage: npx tsx scripts/vendor-template.ts
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { USER_AGENT } from '../src/dbs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = 'CleanroomMC/CleanroomModTemplate';

interface ComponentSpec {
  component: string;
  branch: 'main' | 'mixin';
  path: string;
}

/** Component → upstream (branch, path). 'checklist' is authored, not vendored. */
const COMPONENTS: ComponentSpec[] = [
  { component: 'build.gradle', branch: 'main', path: 'build.gradle' },
  { component: 'gradle.properties', branch: 'main', path: 'gradle.properties' },
  { component: 'settings.gradle', branch: 'main', path: 'settings.gradle' },
  { component: 'mcmod.info', branch: 'main', path: 'src/main/resource-templates/mcmod.info' },
  {
    component: 'ExampleMod.java',
    branch: 'main',
    path: 'src/main/java/com/example/modid/ExampleMod.java',
  },
  {
    component: 'mixins.json',
    branch: 'mixin',
    path: 'src/main/resources/modid.default.mixin.json',
  },
  { component: 'modid_at.cfg', branch: 'main', path: 'src/main/resources/modid_at.cfg' },
  { component: 'README', branch: 'main', path: 'README.md' },
];

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchBranchShas(): Promise<Record<string, string>> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/branches`, {
    headers: githubHeaders(),
  });
  if (!res.ok) throw new Error(`branches: HTTP ${res.status}`);
  const branches = (await res.json()) as Array<{ name: string; commit: { sha: string } }>;
  const out: Record<string, string> = {};
  for (const b of branches) out[b.name] = b.commit.sha;
  return out;
}

/** Fetch a raw file at a pinned SHA, reusing the cleanroom-wiki 3-attempt backoff pattern. */
async function fetchRaw(sha: string, path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${path}`;
  let body: string | null = null;
  for (let attempt = 1; attempt <= 3 && body === null; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.text();
    } catch (err) {
      if (attempt === 3) throw new Error(`Failed to fetch ${path}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return body!;
}

/** Annotation header explaining the blossom tokens; prefixed to the served snapshot. */
function annotate(
  component: string,
  branch: string,
  sha: string,
  path: string,
  raw: string
): string {
  const header = [
    `// ─── CleanroomModTemplate snapshot: ${component} ───`,
    `// Vendored VERBATIM from ${REPO} (${branch}@${sha.slice(0, 7)}) :: ${path}`,
    `// Blossom {{ token }} placeholders are INTACT — your Unimined 1.4.26-kappa + blossom`,
    `// build expands them at build time from gradle.properties. Common tokens:`,
    `//   mod_id, mod_name, root_package, mod_version, is_coremod,`,
    `//   use_access_transformer, coremod_plugin_class_name, mixin_plugin_class_name.`,
    `// The template pins Cleanroom loader 0.5.17-alpha (upstream); the current loader is`,
    `// newer — bump 'cleanroom' in the Unimined block to the version you target.`,
    `// This snapshot uses Unimined (NOT ForgeGradle): mod deps use modImplementation /`,
    `// modCompileOnly, never fg.deobf/rfg.deobf.`,
    `// ────────────────────────────────────────────────────`,
  ].join('\n');
  return `${header}\n\n${raw}`;
}

function slugFor(component: string): string {
  return component
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  const outDir = join(__dirname, '..', 'src', 'templates');
  const dataDir = join(__dirname, '..', 'data');
  await mkdir(outDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  console.log('Fetching branch SHAs…');
  const branchShas = await fetchBranchShas();
  const pins: Record<string, string> = {};
  for (const b of ['main', 'mixin', 'kotlin', 'scala']) {
    if (branchShas[b]) pins[b] = branchShas[b];
  }

  for (const spec of COMPONENTS) {
    const sha = branchShas[spec.branch];
    if (!sha) throw new Error(`No SHA for branch ${spec.branch}`);
    console.log(`  • ${spec.component}  ←  ${spec.branch}@${sha.slice(0, 7)}:${spec.path}`);
    const raw = await fetchRaw(sha, spec.path);
    const annotated = annotate(spec.component, spec.branch, sha, spec.path, raw);
    const file = join(outDir, `${slugFor(spec.component)}.ts`);
    const module =
      `// AUTO-GENERATED by scripts/vendor-template.ts — do not edit by hand.\n` +
      `// Regenerate with: npx tsx scripts/vendor-template.ts\n` +
      `export default ${JSON.stringify(annotated)};\n`;
    await writeFile(file, module, 'utf8');
  }

  const pinsFile = join(dataDir, 'templates-pins.json');
  await writeFile(
    pinsFile,
    JSON.stringify(
      {
        repo: REPO,
        note: 'Per-branch commit SHAs the vendored src/templates/*.ts snapshots were taken from.',
        branches: pins,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  console.log(`\nWrote ${COMPONENTS.length} template modules + data/templates-pins.json`);
  console.log('Remember: src/templates/checklist.ts and index.ts are authored, not generated.');
}

main().catch((err) => {
  console.error('vendor-template failed:', err);
  process.exit(1);
});
