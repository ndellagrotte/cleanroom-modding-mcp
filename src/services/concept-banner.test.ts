import { describe, it, expect } from 'vitest';
import { ConceptService, CONCEPT_TO_TOPIC, type ConceptExplanation } from './concept-service.js';

function baseExplanation(overrides: Partial<ConceptExplanation> = {}): ConceptExplanation {
  return {
    concept: 'networking',
    summary: 'x',
    details: '',
    keyPoints: [],
    codeExamples: [],
    relatedConcepts: [],
    resources: [],
    metadata: { loader: 'cleanroom', sourcesUsed: 2, hasEmbeddings: false, searchStrategy: 'fts' },
    ...overrides,
  };
}

describe('explain_concept cross-loader banner (§4.3)', () => {
  const svc = new ConceptService(':memory:');

  it('renders the "Cross-loader differences" section when equivalence rows are present', () => {
    const out = svc.formatForAI(
      baseExplanation({
        equivalence: [
          {
            entryKey: 'networking/fabric/x',
            topic: 'networking',
            fromVocab: 'fabric',
            fromEra: null,
            fromApi: 'ServerPlayNetworking.send',
            fromApiAlt: [],
            fromVersions: null,
            toLoader: 'cleanroom',
            toApi: 'SimpleNetworkWrapper',
            kind: 'pattern-change',
            notes: null,
            codeBefore: null,
            codeAfter: null,
            caveats: [],
            related: [],
            sources: [],
            validatedAgainst: null,
          },
        ],
      })
    );
    expect(out).toMatch(/Cross-loader differences/);
    expect(out).toMatch(/ServerPlayNetworking\.send/);
  });

  it('never renders the banner when there are no equivalence rows (R7 negative)', () => {
    const out = svc.formatForAI(baseExplanation({ equivalence: undefined }));
    expect(out).not.toMatch(/Cross-loader differences/);
  });

  it('CONCEPT_TO_TOPIC is an exact-key map (no substring aliasing)', () => {
    // Every value must be a plausible topic id; keys are literal concept ids.
    for (const [k, v] of Object.entries(CONCEPT_TO_TOPIC)) {
      expect(typeof k).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
    // A concept id that is NOT a literal key returns nothing — exactness, not substring.
    expect(CONCEPT_TO_TOPIC['register something unrelated']).toBeUndefined();
  });

  it('maps the CANONICAL concept ids users actually type (not just topic slugs)', () => {
    // These are the ids getSuggestedConcepts advertises; the banner must fire for them.
    expect(CONCEPT_TO_TOPIC['event']).toBe('events');
    expect(CONCEPT_TO_TOPIC['mixin']).toBe('mixins-access-transformers');
    expect(CONCEPT_TO_TOPIC['registry']).toBe('registration');
    expect(CONCEPT_TO_TOPIC['gameregistry']).toBe('registration');
    expect(CONCEPT_TO_TOPIC['capabilities']).toBe('capabilities-attachments');
  });
});
