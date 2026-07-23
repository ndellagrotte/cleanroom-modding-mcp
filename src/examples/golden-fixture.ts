/**
 * Offline golden fixtures for the examples pipeline (DESIGN §7).
 *
 * Builds a deterministic examples.db fully offline: canned LLM responses (a fake
 * endpoint), a fixture mappings DB seeding func_180495_p → getBlockState, and a
 * fixture Cleanroom API DB seeding one event type. Exercises the real
 * select→analyze→srg-link→ingest path with no network. Shared by the vitest
 * goldens and scripts/build-golden-db.ts.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeMappingsDb } from '../mappings/schema.js';
import { initializeCleanroomApiDb } from '../cleanroom-api/schema.js';
import { MappingsService } from '../services/mappings-service.js';
import { CleanroomApiService } from '../services/cleanroom-api-service.js';
import { analyzeSnippet, computeAnalysisVersion, PIPELINE_REV } from './analyze.js';
import { resolveApiReferences, toExampleRecord } from './srg-link.js';
import { runIngest, type ModMeta } from './ingest.js';
import type {
  AnalyzedSnippet,
  ExampleRecord,
  IngestCounts,
  IngestMeta,
  LlmClient,
  Snippet,
} from './model.js';

const FIXTURE_PROMPT = 'FIXTURE PROMPT — return the recorded JSON.';
const FAKE_MODEL = 'fake-endpoint-model';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture mods + snippets (one forge, one cleanroom — so loader filters differ)
// ─────────────────────────────────────────────────────────────────────────────

export const FIXTURE_MODS: ModMeta[] = [
  {
    name: 'MinecraftByExample',
    repo: 'TheGreyGhost/MinecraftByExample',
    loader: 'forge',
    license: 'Unlicense',
    description: 'Purpose-built 1.12.2 Forge teaching corpus.',
    minecraftVersions: ['1.12.2'],
    priority: 2,
  },
  {
    name: 'ModularUI',
    repo: 'CleanroomMC/ModularUI',
    loader: 'cleanroom',
    license: 'LGPL-3.0',
    description: 'Cleanroom-native GUI library.',
    minecraftVersions: ['1.12.2'],
    priority: 1,
  },
];

const FORGE_CODE = `package minecraftbyexample.mbe01;

import net.minecraft.world.World;
import net.minecraft.util.math.BlockPos;
import net.minecraft.block.state.IBlockState;

public class StartupCommon {
    public IBlockState readState(World world, BlockPos pos) {
        IBlockState state = world.func_180495_p(pos);
        return state;
    }
}`;

const CLEANROOM_CODE = `package com.cleanroommc.modularui.widget;

import com.cleanroommc.modularui.api.widget.IWidget;

public class BlockPreviewWidget implements IWidget {
    public void draw() {
        // render a block preview
    }
}`;

export const FIXTURE_SNIPPETS: Snippet[] = [
  {
    repo: 'TheGreyGhost/MinecraftByExample',
    modName: 'MinecraftByExample',
    loader: 'forge',
    license: 'Unlicense',
    filePath: 'src/main/java/minecraftbyexample/mbe01/StartupCommon.java',
    fileUrl:
      'https://github.com/TheGreyGhost/MinecraftByExample/blob/01ac397d2e900b5806e35ea63715de9fecb116e1/src/main/java/minecraftbyexample/mbe01/StartupCommon.java#L7-L10',
    startLine: 7,
    endLine: 10,
    code: FORGE_CODE,
    language: 'java',
    imports: [
      'net.minecraft.world.World',
      'net.minecraft.util.math.BlockPos',
      'net.minecraft.block.state.IBlockState',
    ],
  },
  {
    repo: 'CleanroomMC/ModularUI',
    modName: 'ModularUI',
    loader: 'cleanroom',
    license: 'LGPL-3.0',
    filePath: 'src/main/java/com/cleanroommc/modularui/widget/BlockPreviewWidget.java',
    fileUrl:
      'https://github.com/CleanroomMC/ModularUI/blob/f2aa7210f42ffae4458c6777f723a55546a772bc/src/main/java/com/cleanroommc/modularui/widget/BlockPreviewWidget.java#L5-L8',
    startLine: 5,
    endLine: 8,
    code: CLEANROOM_CODE,
    language: 'java',
    imports: ['com.cleanroommc.modularui.api.widget.IWidget'],
  },
];

/** Recorded model responses keyed by a substring unique to the prompt. */
const FIXTURE_RESPONSES: Record<string, string> = {
  'StartupCommon.java': JSON.stringify({
    title: 'Reading a block state',
    caption: 'Reads the block state at a position via the SRG-named getter.',
    explanation: 'Uses world.func_180495_p (getBlockState) to read the IBlockState at a BlockPos.',
    category: 'blocks',
    pattern_type: 'blockstate-access',
    complexity: 'beginner',
    quality_score: 0.8,
    best_practices: ['Use SRG-safe accessors'],
    potential_pitfalls: ['Do not call client-side for server logic'],
    use_cases: ['Reading block state in a tile entity'],
    keywords: ['block', 'blockstate', 'world'],
    minecraft_concepts: ['IBlockState', 'BlockPos'],
    tags: ['blocks', 'blockstate'],
    api_references: [
      { class_name: 'PlayerInteractEvent.RightClickBlock', method_name: null, api_type: 'forge' },
    ],
  }),
  'BlockPreviewWidget.java': JSON.stringify({
    title: 'Block preview widget',
    caption: 'A ModularUI widget that previews a block.',
    explanation: 'Implements IWidget to draw a block preview in a Cleanroom GUI.',
    category: 'gui',
    pattern_type: 'widget',
    complexity: 'intermediate',
    quality_score: 0.6,
    best_practices: ['Keep draw() side-effect free'],
    potential_pitfalls: [],
    use_cases: ['Custom GUIs'],
    keywords: ['gui', 'widget', 'block'],
    minecraft_concepts: ['GUI'],
    tags: ['gui', 'widget'],
    api_references: [],
  }),
};

/** A fake LlmClient that returns recorded JSON for a known snippet. */
export function makeFakeClient(): LlmClient {
  return {
    model: FAKE_MODEL,
    complete(prompt: string): Promise<string> {
      for (const [needle, json] of Object.entries(FIXTURE_RESPONSES)) {
        if (prompt.includes(needle)) {
          return Promise.resolve(json);
        }
      }
      return Promise.resolve(JSON.stringify({ title: 'Unknown', quality_score: 0.3 }));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture sibling DBs
// ─────────────────────────────────────────────────────────────────────────────

/** A mappings DB mapping func_180495_p → getBlockState at 1.12.2 (mcp). */
export function buildFixtureMappingsDb(dbPath: string): void {
  const db = initializeMappingsDb(dbPath);
  try {
    const cls = db
      .prepare(
        `INSERT INTO classes (name, package_name, notch_name, javadoc, minecraft_version, mapping_set)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('World', 'net.minecraft.world', null, null, '1.12.2', 'mcp');
    db.prepare(
      `INSERT INTO methods (class_id, name, srg_name, notch_name, descriptor, javadoc)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      cls.lastInsertRowid,
      'getBlockState',
      'func_180495_p',
      null,
      '(Lnet/minecraft/util/math/BlockPos;)Lnet/minecraft/block/state/IBlockState;',
      null
    );
  } finally {
    db.close();
  }
}

/** A Cleanroom API DB seeding one event type (PlayerInteractEvent.RightClickBlock). */
export function buildFixtureCleanroomApiDb(dbPath: string): void {
  const db = initializeCleanroomApiDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO types (
        fqn, simple_name, package_name, outer_fqn, kind, loader, modifiers, signature,
        extends_raw, extends_fqn, implements_raw, implements_fqns, annotations, javadoc,
        javadoc_summary, is_deprecated, deprecation_note, since, is_event, is_cancelable,
        has_result, source_file, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'net.minecraftforge.event.entity.player.PlayerInteractEvent.RightClickBlock',
      'RightClickBlock',
      'net.minecraftforge.event.entity.player',
      'net.minecraftforge.event.entity.player.PlayerInteractEvent',
      'class',
      'forge',
      'public static',
      'public static class RightClickBlock',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      1,
      1,
      0,
      'net/minecraftforge/event/entity/player/PlayerInteractEvent.java',
      'rightclickblock right click block player interact event'
    );
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full offline golden build
// ─────────────────────────────────────────────────────────────────────────────

/** Build a populated examples.db at dbPath, fully offline. */
export async function buildGoldenDb(dbPath: string): Promise<IngestCounts> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'examples-golden-'));
  const mappingsPath = path.join(tmpDir, 'mappings.db');
  const apiPath = path.join(tmpDir, 'cleanroom-api.db');
  buildFixtureMappingsDb(mappingsPath);
  buildFixtureCleanroomApiDb(apiPath);

  const mappings = new MappingsService(mappingsPath);
  const api = new CleanroomApiService(apiPath);
  const client = makeFakeClient();
  const records: ExampleRecord[] = [];

  try {
    for (const snippet of FIXTURE_SNIPPETS) {
      const analysis = await analyzeSnippet(snippet, client, FIXTURE_PROMPT);
      const analyzed: AnalyzedSnippet = { snippet, analysis };
      const refs = resolveApiReferences(analyzed, { mappings, api, minecraftVersion: '1.12.2' });
      records.push(toExampleRecord(analyzed, refs));
    }
  } finally {
    mappings.close();
    api.close();
  }

  const meta: IngestMeta = {
    analysisVersion: computeAnalysisVersion({
      promptVersion: 'v1',
      model: client.model,
      pipelineRev: PIPELINE_REV,
    }),
    promptVersion: 'v1',
    llmModel: client.model,
    rosterPins: {
      'TheGreyGhost/MinecraftByExample': '01ac397d2e900b5806e35ea63715de9fecb116e1',
      'CleanroomMC/ModularUI': 'f2aa7210f42ffae4458c6777f723a55546a772bc',
    },
    licenseReview: {
      'TheGreyGhost/MinecraftByExample': {
        verdict: 'approved',
        by: 'ndellagrotte',
        date: '2026-07-22',
        license: 'Unlicense',
      },
      'CleanroomMC/ModularUI': {
        verdict: 'approved',
        by: 'ndellagrotte',
        date: '2026-07-22',
        license: 'LGPL-3.0',
      },
    },
  };

  const counts = runIngest({ dbPath, records, mods: FIXTURE_MODS, meta });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return counts;
}
