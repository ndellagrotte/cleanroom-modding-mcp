import { describe, it, expect } from 'vitest';
import { MOD_EXAMPLES_TOOLS, searchModExamplesTool, handleGetModExample } from './modExamples.js';
import { EXAMPLE_CATEGORIES } from '../categories.js';

describe('search_mod_examples tool schema', () => {
  it('sources its category enum from EXAMPLE_CATEGORIES (no drift)', () => {
    const props = searchModExamplesTool.inputSchema.properties as {
      category: { enum: string[] };
      loader: { enum: string[] };
    };
    expect([...props.category.enum].sort()).toEqual([...EXAMPLE_CATEGORIES].sort());
  });

  it('exposes a loader filter param (forge | cleanroom)', () => {
    const props = searchModExamplesTool.inputSchema.properties as { loader: { enum: string[] } };
    expect(props.loader.enum).toEqual(['forge', 'cleanroom']);
  });
});

describe('tool copy', () => {
  it('no longer advertises the dead Create / Botania / AE2 corpus', () => {
    const text = JSON.stringify(MOD_EXAMPLES_TOOLS);
    expect(/create|botania|applied energistics/i.test(text)).toBe(false);
  });
});

describe('cross-tool routing', () => {
  it('points back at get_doc_snippet and never at the old get_example name', () => {
    expect(searchModExamplesTool.description).toContain('get_doc_snippet');
    expect(searchModExamplesTool.description).not.toContain('get_example');
  });
});

describe('get_mod_example dispatch validation', () => {
  it('treats a missing id as a validation error, not id=0', () => {
    const res = handleGetModExample({} as { id: number });
    expect(res.isError).toBe(true);
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(/invalid|required/i.test(text)).toBe(true);
    expect(text).not.toMatch(/example 0/i);
  });
});
