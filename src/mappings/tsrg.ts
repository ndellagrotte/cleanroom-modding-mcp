/**
 * TSRG parsing and JVM-descriptor utilities for the MCP/SRG mapping era.
 *
 * Supports both TSRG formats found in MCPConfig zips:
 *   - v1: no header; class lines `<obf> <named>`, tab-indented member lines
 *     (`<obf> <srg>` for fields — no descriptor — and `<obf> <obfDesc> <srg>`
 *     for methods).
 *   - v2: `tsrg2 <col0> <col1> ...` header; member lines may be followed by
 *     double-tab sub-lines: a literal `static` marker or `<lvtIndex> <obf> <named...>`
 *     parameter lines.
 *
 * SRG parameter tokens are numbered by JVM local-variable-table slot, not by
 * logical position: instance methods start at slot 1 (`this` = 0), statics at
 * slot 0, and `long`/`double` parameters consume two slots. `slotToParamIndex`
 * / `paramSlots` implement that math from the method descriptor.
 */

export interface TsrgField {
  obfName: string;
  srgName: string;
  /** Only present in TSRG v2. */
  obfDescriptor: string | null;
}

export interface TsrgMethod {
  obfName: string;
  obfDescriptor: string;
  srgName: string;
  /** From v2 `static` markers; the MCP era also consults static_methods.txt. */
  isStatic: boolean;
  /** v2 parameter sub-lines: LVT slot -> named parameter. */
  params: Array<{ slot: number; name: string }>;
}

export interface TsrgClass {
  obfName: string;
  /** Named internal name, e.g. `net/minecraft/block/Block$1`. */
  name: string;
  fields: TsrgField[];
  methods: TsrgMethod[];
}

export interface TsrgData {
  format: 'v1' | 'v2';
  classes: TsrgClass[];
}

const FIELD_DESCRIPTOR = /^\[*([BCDFIJSZ]|L[^;]+;)$/;

export function parseTsrg(text: string): TsrgData {
  const lines = text.split('\n');
  const firstLine = lines[0] ?? '';
  const isV2 = firstLine.startsWith('tsrg2');
  /** Number of name columns per line (v2 declares them in the header; v1 has 2). */
  const nameColumns = isV2 ? Math.max(firstLine.trim().split(/\s+/).length - 1, 2) : 2;
  const classes: TsrgClass[] = [];
  let currentClass: TsrgClass | null = null;
  let currentMethod: TsrgMethod | null = null;

  for (let i = isV2 ? 1 : 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('\t\t')) {
      // v2 sub-line: `static` marker or parameter line `<slot> <obf> <named...>`
      if (!currentMethod) {
        continue;
      }
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'static') {
        currentMethod.isStatic = true;
        continue;
      }
      const slot = Number.parseInt(parts[0] ?? '', 10);
      // Prefer the last column (the most-renamed domain), fall back to obf.
      const name = parts.length >= 3 ? parts[parts.length - 1] : parts[1];
      if (!Number.isNaN(slot) && name) {
        currentMethod.params.push({ slot, name });
      }
      continue;
    }

    if (line.startsWith('\t')) {
      if (!currentClass) {
        continue;
      }
      currentMethod = null;
      const parts = line.trim().split(/\s+/);
      const first = parts[0];
      const second = parts[1];
      if (!first || !second) {
        continue;
      }
      if (second.startsWith('(')) {
        // Method: <obf> <obfDesc> <srg> [more columns in v2]
        const srg = parts[2];
        if (!srg) {
          continue;
        }
        currentMethod = {
          obfName: first,
          obfDescriptor: second,
          srgName: srg,
          isStatic: false,
          params: [],
        };
        currentClass.methods.push(currentMethod);
      } else if (
        parts.length > nameColumns &&
        FIELD_DESCRIPTOR.test(second) &&
        parts[2] !== undefined
      ) {
        // v2 field with descriptor: <obf> <fieldDesc> <srg> [more columns]
        currentClass.fields.push({ obfName: first, srgName: parts[2], obfDescriptor: second });
      } else {
        // Field without descriptor: <obf> <srg> [more columns in v2]
        currentClass.fields.push({ obfName: first, srgName: second, obfDescriptor: null });
      }
      continue;
    }

    // Class line: <obf> <named> [more columns in v2]
    currentMethod = null;
    const parts = line.trim().split(/\s+/);
    const obf = parts[0];
    const named = parts[1];
    if (!obf || !named) {
      continue;
    }
    currentClass = { obfName: obf, name: named, fields: [], methods: [] };
    classes.push(currentClass);
  }

  return { format: isV2 ? 'v2' : 'v1', classes };
}

/** Rewrite every `L<internal>;` class reference in a descriptor through the map. */
export function remapDescriptor(descriptor: string, classMap: Map<string, string>): string {
  return descriptor.replace(/L([^;]+);/g, (_m, internal: string) => {
    return `L${classMap.get(internal) ?? internal};`;
  });
}

/** Split a named internal class name into dotted package + simple name. */
export function splitInternalName(internal: string): { packageName: string; simpleName: string } {
  const lastSlash = internal.lastIndexOf('/');
  if (lastSlash < 0) {
    return { packageName: '', simpleName: internal };
  }
  return {
    packageName: internal.substring(0, lastSlash).replace(/\//g, '.'),
    simpleName: internal.substring(lastSlash + 1),
  };
}

/** Parse the parameter type list out of a JVM method descriptor. */
export function parseDescriptorParams(descriptor: string): string[] {
  const close = descriptor.indexOf(')');
  if (!descriptor.startsWith('(') || close < 0) {
    return [];
  }
  const body = descriptor.substring(1, close);
  const params: string[] = [];
  let i = 0;
  while (i < body.length) {
    let start = i;
    while (body[i] === '[') {
      i++;
    }
    if (body[i] === 'L') {
      const semi = body.indexOf(';', i);
      if (semi < 0) {
        break; // malformed
      }
      i = semi + 1;
    } else {
      i++;
    }
    params.push(body.substring(start, i));
  }
  return params;
}

/** True when a (possibly array) type occupies two LVT slots. */
function isWide(type: string): boolean {
  return type === 'J' || type === 'D';
}

/**
 * All parameter positions of a method with their LVT slots.
 * Instance methods start at slot 1 (`this` occupies slot 0), statics at 0.
 */
export function paramSlots(
  descriptor: string,
  isStatic: boolean
): Array<{ index: number; slot: number }> {
  const types = parseDescriptorParams(descriptor);
  const result: Array<{ index: number; slot: number }> = [];
  let slot = isStatic ? 0 : 1;
  for (let index = 0; index < types.length; index++) {
    result.push({ index, slot });
    slot += isWide(types[index] ?? '') ? 2 : 1;
  }
  return result;
}

/** Map an LVT slot back to the 0-based logical parameter index, or null. */
export function slotToParamIndex(
  descriptor: string,
  slot: number,
  isStatic: boolean
): number | null {
  for (const entry of paramSlots(descriptor, isStatic)) {
    if (entry.slot === slot) {
      return entry.index;
    }
  }
  return null;
}
