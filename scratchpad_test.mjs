import { jsonrepair } from 'jsonrepair';

function extractJsonObject(raw) {
  const trimmed = raw.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return { ok: true, via: 'direct', value: direct };
    }
  } catch {}
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  const slice = first !== -1 && last > first ? trimmed.slice(first, last + 1) : trimmed;
  let repaired, parsed;
  try {
    repaired = jsonrepair(slice);
  } catch (e) {
    return { ok: false, stage: 'jsonrepair-threw', error: String(e).split('\n')[0] };
  }
  try {
    parsed = JSON.parse(repaired);
  } catch (e) {
    return { ok: false, stage: 'json.parse-threw', repaired, error: String(e).split('\n')[0] };
  }
  return { ok: true, via: 'fallback', repaired, value: parsed, type: typeof parsed, isArray: Array.isArray(parsed) };
}

const cases = [
  'I cannot analyze this snippet.',
  'I cannot analyze this snippet',
  'Sorry, I am unable to help with that request.',
  'This code sets up a block entity.',
  'The snippet registers a block: use DeferredRegister.',
  'null',
  'undefined',
  '',
  'no',
  'N/A',
];

for (const c of cases) {
  const r = extractJsonObject(c);
  console.log(JSON.stringify(c) + '  =>  ' + JSON.stringify(r));
}
