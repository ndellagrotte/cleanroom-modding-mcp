/**
 * Parsers for the MCP `mcp_stable` CSV data (SRG -> readable names) and the
 * MCPConfig side files (constructors.txt, static_methods.txt).
 *
 * fields.csv / methods.csv: header `searge,name,side,desc` — `desc` is javadoc
 * and may contain quoted commas, so a real quoted-field CSV parser is required.
 * params.csv: header `param,name,side`.
 */

/** Minimal RFC-4180-style CSV: quoted fields, escaped quotes (""), \r\n tolerant. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      pushField();
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing field/row (files usually end with a newline; guard when they don't)
  if (field !== '' || row.length > 0) {
    pushRow();
  }
  return rows;
}

export interface McpName {
  name: string;
  javadoc: string | null;
}

/**
 * Parse fields.csv / methods.csv (`searge,name,side,desc`) into srg -> readable.
 * The header row is skipped when present.
 */
export function parseMcpNamesCsv(text: string): Map<string, McpName> {
  const map = new Map<string, McpName>();
  for (const row of parseCsv(text)) {
    const searge = row[0];
    const name = row[1];
    if (!searge || !name || searge === 'searge') {
      continue;
    }
    const desc = row[3];
    map.set(searge, { name, javadoc: desc && desc.trim() !== '' ? desc : null });
  }
  return map;
}

/** Parse params.csv (`param,name,side`) into srg token -> readable name. */
export function parseParamsCsv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of parseCsv(text)) {
    const param = row[0];
    const name = row[1];
    if (!param || !name || param === 'param') {
      continue;
    }
    map.set(param, name);
  }
  return map;
}

export interface McpConstructor {
  id: number;
  /** Named internal owner class, e.g. `net/minecraft/block/Block`. */
  owner: string;
  /** JVM descriptor in the named domain. */
  descriptor: string;
}

/** Parse constructors.txt lines: `<id> <owner> <descriptor>`. */
export function parseConstructors(text: string): McpConstructor[] {
  const result: McpConstructor[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\s+/);
    const id = Number.parseInt(parts[0] ?? '', 10);
    const owner = parts[1];
    const descriptor = parts[2];
    if (Number.isNaN(id) || !owner || !descriptor || !descriptor.startsWith('(')) {
      continue;
    }
    result.push({ id, owner, descriptor });
  }
  return result;
}

/** Parse static_methods.txt: one SRG method name per line. */
export function parseStaticMethods(text: string): Set<string> {
  const set = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line !== '' && !line.startsWith('#')) {
      set.add(line);
    }
  }
  return set;
}
