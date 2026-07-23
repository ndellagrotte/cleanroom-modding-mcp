-- verify/corpus.sql
.mode list
.separator '  ->  '
.headers off

-- non-empty seed corpus
SELECT 'corpus non-empty', CASE WHEN count(*)>=1 THEN 'PASS' ELSE 'FAIL' END FROM equivalence;

-- entry_key UNIQUE (belt-and-braces vs the UNIQUE constraint)
SELECT 'entry_key unique', CASE WHEN count(*)=count(DISTINCT entry_key) THEN 'PASS' ELSE 'FAIL' END FROM equivalence;

-- entry_key shape: '<topic>/<from_vocab>/<slug>'
SELECT 'entry_key shape', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE entry_key <> topic||'/'||from_vocab||'/'||substr(entry_key, length(topic||'/'||from_vocab||'/')+1)
   OR entry_key NOT LIKE topic||'/'||from_vocab||'/%';

-- from_vocab enum (the three; NEVER a Loader value)
SELECT 'from_vocab enum', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE from_vocab NOT IN ('fabric','neoforge','modern-minecraft');

-- to_loader enum
SELECT 'to_loader enum', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE to_loader NOT IN ('cleanroom','forge');

-- kind enum (redundant w/ CHECK, kept for the frozen record)
SELECT 'kind enum', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE kind NOT IN ('direct','analog','pattern-change','missing');

-- from_era enum OR null
SELECT 'from_era enum', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE from_era IS NOT NULL AND from_era NOT IN
  ('yarn-<=1.21.11','mojang-26x','fabric-pre-1.20.5','legacy-modern-forge-1.16-1.20.1');

-- topic in the seed taxonomy
SELECT 'topic in taxonomy', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE topic NOT IN (
 'registration','events','networking','mixins-access-transformers','capabilities-attachments',
 'item-block-settings','resources-datagen','fluids','serialization-nbt-codecs','resource-loading',
 'energy-transfer','enchantments','advancements','permissions','particles','config',
 'data-components','block-entity-renderer','text-components');

-- to_api present unless kind='missing' (DESIGN §6.2 validation rule)
SELECT 'to_api required unless missing', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE kind<>'missing' AND (to_api IS NULL OR trim(to_api)='');

-- from_api always present
SELECT 'from_api present', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE from_api IS NULL OR trim(from_api)='';

-- JSON-array columns are valid JSON arrays when non-null
SELECT 'from_api_alt json', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END FROM equivalence WHERE from_api_alt IS NOT NULL AND (json_valid(from_api_alt)=0 OR json_type(from_api_alt)<>'array');
SELECT 'caveats json',      CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END FROM equivalence WHERE caveats      IS NOT NULL AND (json_valid(caveats)=0      OR json_type(caveats)<>'array');
SELECT 'related json',      CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END FROM equivalence WHERE related      IS NOT NULL AND (json_valid(related)=0      OR json_type(related)<>'array');
SELECT 'sources json',      CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END FROM equivalence WHERE sources      IS NOT NULL AND (json_valid(sources)=0      OR json_type(sources)<>'array');

-- keywords compile-derived and non-empty (§5.1 "compile-derived: split identifiers")
SELECT 'keywords non-empty', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE keywords IS NULL OR json_valid(keywords)=0 OR json_array_length(keywords)<1;

-- every entry has >=1 source (§6.2 "non-empty sources[]")
SELECT 'sources non-empty', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE sources IS NULL OR json_array_length(sources)<1;

-- LICENSING (§2, §6.3): no source may declare an LGPL family license.
SELECT 'no LGPL sources', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence e, json_each(e.sources) s
WHERE upper(json_extract(s.value,'$.license')) LIKE 'LGPL%';

-- related[] links only use the blessed schemes (§3.4).
SELECT 'related scheme', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence e, json_each(e.related) r
WHERE r.value NOT LIKE 'cleanroom://equivalence/%'
  AND r.value NOT LIKE 'cleanroom://guide/%'
  AND r.value NOT LIKE 'cleanroom://template/%'
  AND r.value NOT LIKE 'api://%'
  AND r.value NOT LIKE '%/%/%';

-- referential integrity: every cleanroom://equivalence/<key> related-link resolves to a real entry_key.
SELECT 'related equivalence links resolve', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence e, json_each(e.related) r
WHERE r.value LIKE 'cleanroom://equivalence/%'
  AND substr(r.value, length('cleanroom://equivalence/')+1) NOT IN (SELECT entry_key FROM equivalence);

-- referential integrity: cleanroom://guide/<name> links point at one of the four guides (fragment allowed).
SELECT 'related guide links valid', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence e, json_each(e.related) r
WHERE r.value LIKE 'cleanroom://guide/%'
  AND CASE
        WHEN instr(substr(r.value, length('cleanroom://guide/')+1), '#') > 0
        THEN substr(substr(r.value, length('cleanroom://guide/')+1), 1, instr(substr(r.value, length('cleanroom://guide/')+1), '#')-1)
        ELSE substr(r.value, length('cleanroom://guide/')+1)
      END NOT IN ('porting-from-fabric','porting-from-neoforge','backporting','mixin-setup');
