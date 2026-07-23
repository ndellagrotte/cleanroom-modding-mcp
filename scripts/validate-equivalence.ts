#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * CI gate: validate the equivalence corpus without touching any database.
 * Runs before indexing (npm script `validate:equivalence`).
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compileEquivalence } from './equivalence-compile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const dir = join(__dirname, '..', 'data', 'equivalence');
  const { entries, errors, fileCount } = await compileEquivalence(dir);

  if (errors.length > 0) {
    console.error(`✗ equivalence corpus: ${errors.length} error(s) across ${fileCount} file(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(`✓ equivalence corpus valid: ${entries.length} entries across ${fileCount} file(s)`);
}

main().catch((err) => {
  console.error('validate:equivalence failed:', err);
  process.exit(1);
});
