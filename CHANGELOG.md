## Unreleased

### Bug Fixes

- **examples:** synchronize shared category metadata in place during ingest, data-side upgrades,
  server startup, docs indexing, and release preparation. Add `lint:corpus --fix-categories`
  to repair carried-forward databases without rebuilding docs or re-running paid analyses,
  preserving category/example IDs and keeping corpus lint strict.
- **examples:** reject empty, budget-truncated, and coverage-rejected builds before replacing
  the database or manifest. Retain completed analyses in the enabled cache for resumption,
  and validate corpus contents before accepting an up-to-date database.
- **examples:** return zero pattern counts instead of an error for empty or entirely
  unlabeled corpora.
- **tests:** use deterministic example fixtures for ranking, cross-tool references, related
  examples, and bounded pattern output instead of depending on generated release-corpus IDs.
- Reject empty, budget-truncated, and coverage-rejected builds before replacing the database or manifest.
- Preserve cached analyses for resumption and validate corpus contents before accepting an up-to-date database.
- Return zero pattern counts for empty or entirely unlabeled corpora.
- Replace release-corpus-dependent assertions with deterministic SQLite fixtures.
- Add regressions for artifact preservation, cache-based recovery, and empty-corpus handling.
- Update build-contract documentation and changelog.
## [2.2.0](https://github.com/ndellagrotte/cleanroom-modding-mcp/compare/v2.1.6...v2.2.0) (2026-08-04)

### Features

- **tools:** rename `get_example` to `get_doc_snippet`. Its description now states that it
  searches the scraped documentation corpus and routes to `search_mod_examples` for
  implementations taken from real 1.12.2 mods; `search_mod_examples` links back. Agents were
  systematically picking the documentation tool for questions only the curated mod-examples
  corpus could answer. The old name still dispatches (unlisted) and emits a deprecation notice;
  it will be removed in 3.0.0.

### Bug Fixes

- **search:** cap documentation snippets at one per source document, so a single page with
  several code blocks no longer consumes the whole `limit`. A page may repeat only once distinct
  pages are exhausted, and such repeats are now labelled in the output.
- **search:** apply a relevance floor to pooled example scores. Results that matched nothing and
  scored the flat "has substantial code" value are no longer served as answers, so an
  unanswerable query reaches the empty-result block instead of returning padding.
- **search:** apply the `language` filter in the semantic strategy — it was the only strategy
  skipping it, which is how JSON blocks reached a `java` query — and compare languages
  case-insensitively, recovering the `Java`/`JAVA`-tagged blocks that every filter dropped.
- **search:** fix the deduplication key for code-less results, which read a `url` field that
  code-block results never carry.
