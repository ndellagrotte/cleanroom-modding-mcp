import { runIngest } from './ingest.js';
import type { ModMeta } from './ingest.js';
import type { ExampleRecord, IngestMeta } from './model.js';

const EXAMPLE_TEST_MODS: ModMeta[] = [
  {
    name: 'Fixture Forge',
    repo: 'fixture/forge',
    loader: 'forge',
    license: 'MIT',
    minecraftVersions: ['1.12.2'],
    priority: 1,
  },
  {
    name: 'Fixture Cleanroom',
    repo: 'fixture/cleanroom',
    loader: 'cleanroom',
    license: 'MIT',
    minecraftVersions: ['1.12.2'],
    priority: 1,
  },
];

const META: IngestMeta = {
  analysisVersion: 'fixture',
  promptVersion: 'fixture',
  llmModel: 'fixture',
  rosterPins: { 'fixture/forge': 'fixture', 'fixture/cleanroom': 'fixture' },
  licenseReview: {},
};

/** Controlled records shared by service and real-handler regressions. */
export function exampleRecord(
  title: string,
  overrides: Partial<ExampleRecord> = {}
): ExampleRecord {
  return {
    modName: 'Fixture Forge',
    modRepo: 'fixture/forge',
    loader: 'forge',
    license: 'MIT',
    filePath: `${title}.java`,
    fileUrl: 'https://github.com/fixture/forge/blob/fixture/Example.java#L1-L2',
    startLine: 1,
    endLine: 2,
    title,
    code: 'class Example {}',
    language: 'java',
    caption: '',
    explanation: '',
    patternType: 'utility',
    complexity: 'beginner',
    categorySlug: 'blocks',
    bestPractices: [],
    potentialPitfalls: [],
    useCases: [],
    keywords: [],
    minecraftConcepts: [],
    qualityScore: 0.8,
    isFeatured: false,
    tags: [],
    imports: [],
    apiReferences: [],
    ...overrides,
  };
}

export function writeExampleFixture(dbPath: string, records: ExampleRecord[]): void {
  runIngest({ dbPath, records, mods: EXAMPLE_TEST_MODS, meta: META });
}
