#!/usr/bin/env npx tsx
/* eslint-disable no-console */
/**
 * Build the offline golden examples DB (DESIGN §7 / BLIND_SPEC §1).
 *
 * Emits a fully-populated examples.db to $GOLDEN_DB (or data/examples-golden.db)
 * with ZERO network access — a fake LLM endpoint + fixture sibling DBs. Used by
 * the acceptance oracle and as a hand-runnable fixture builder.
 */

import path from 'path';
import { buildGoldenDb } from '../src/examples/golden-fixture.js';

async function main(): Promise<void> {
  const dbPath = process.env.GOLDEN_DB || path.join(process.cwd(), 'data', 'examples-golden.db');
  const counts = await buildGoldenDb(dbPath);
  console.log(`✅ Golden examples DB written to ${dbPath}`);
  console.log(`   mods=${counts.mods} examples=${counts.examples} apiRefs=${counts.apiReferences}`);
  console.log(`   srgResolved=${counts.srgResolved} frameworkLinked=${counts.apiResolved}`);
}

main().catch((error) => {
  console.error(`❌ Golden build failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
