/**
 * Mojang ProGuard-style official mappings parser.
 *
 * Extracted from scripts/index-mappings.ts so the parse is testable without
 * downloading a client_mappings.txt from piston-meta. The indexer feeds the
 * result into the `parchment` era of mappings.db to recover obfuscated (notch)
 * names for modern Minecraft versions.
 */

/** Parsed Mojang ProGuard-style mappings */
export interface MojangMappings {
  classes: Map<string, MojangClassMapping>;
}

export interface MojangClassMapping {
  deobfuscated: string; // e.g., "net.minecraft.world.entity.player.Player"
  obfuscated: string; // e.g., "xyz"
  methods: Map<string, MojangMethodMapping>;
  fields: Map<string, MojangFieldMapping>;
}

export interface MojangMethodMapping {
  deobfuscated: string; // method name only
  obfuscated: string;
  args: string; // Java-style comma-separated argument types
  returnType: string; // Java-style return type
}

export interface MojangFieldMapping {
  deobfuscated: string; // field name only
  obfuscated: string;
  type: string; // field type
}

/** Parchment field data before Mojang's complete member set is merged in. */
export interface ParchmentFieldData {
  name: string;
  descriptor: string;
  javadoc?: string[];
}

/** Field row ready for the modern mappings database. */
export interface IndexedModernField {
  name: string;
  notchName: string | null;
  descriptor: string;
  javadoc: string | null;
}

const JAVA_PRIMITIVES: Readonly<Record<string, string>> = {
  byte: 'B',
  char: 'C',
  double: 'D',
  float: 'F',
  int: 'I',
  long: 'J',
  short: 'S',
  boolean: 'Z',
  void: 'V',
};

/** Convert a Java source type from Mojang's ProGuard file to a JVM descriptor. */
export function javaTypeToJvmDescriptor(javaType: string): string {
  let type = javaType.trim();
  let arrayDimensions = 0;
  while (type.endsWith('[]')) {
    arrayDimensions++;
    type = type.slice(0, -2).trim();
  }

  const base = JAVA_PRIMITIVES[type] ?? `L${type.replace(/\./g, '/')};`;
  return '['.repeat(arrayDimensions) + base;
}

/** Convert one Mojang ProGuard method signature to a JVM descriptor. */
export function javaMethodToJvmDescriptor(args: string, returnType: string): string {
  const parameters =
    args.trim() === ''
      ? ''
      : args
          .split(',')
          .map((argument) => javaTypeToJvmDescriptor(argument))
          .join('');
  return `(${parameters})${javaTypeToJvmDescriptor(returnType)}`;
}

/**
 * Merge Parchment's documented-field subset with Mojang's complete field list.
 *
 * Parchment supplies Javadocs and authoritative JVM descriptors, but omits
 * undocumented fields. Mojang supplies every mapped field and its obfuscated
 * name. A modern class listing must contain their union rather than only the
 * small documented subset.
 */
export function mergeModernFields(
  parchmentFields: readonly ParchmentFieldData[] | undefined,
  mojangClass: MojangClassMapping | undefined
): IndexedModernField[] {
  const fields: IndexedModernField[] = [];
  const seen = new Set<string>();

  for (const field of parchmentFields ?? []) {
    if (seen.has(field.name)) continue;
    seen.add(field.name);
    fields.push({
      name: field.name,
      notchName: mojangClass?.fields.get(field.name)?.obfuscated ?? null,
      descriptor: field.descriptor,
      javadoc: field.javadoc?.join('\n') || null,
    });
  }

  for (const field of mojangClass?.fields.values() ?? []) {
    if (seen.has(field.deobfuscated)) continue;
    seen.add(field.deobfuscated);
    fields.push({
      name: field.deobfuscated,
      notchName: field.obfuscated,
      descriptor: javaTypeToJvmDescriptor(field.type),
      javadoc: null,
    });
  }

  return fields;
}

/**
 * Read a capture group the pattern guarantees.
 *
 * Under `noUncheckedIndexedAccess` every `match[n]` is `string | undefined`,
 * but each group below is structurally mandatory — an absent one means the
 * pattern was edited, not that the input was unusual. Fail loudly rather than
 * let an `undefined` reach a mappings.db write, where it would land as a NULL
 * that nothing downstream reports.
 */
function capture(match: RegExpMatchArray, index: number, what: string): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`${what}: capture group ${index} missing in "${match[0] ?? ''}"`);
  }
  return value;
}

/**
 * Parse Mojang ProGuard-style mappings.
 *
 * Format:
 * - Class: `fully.qualified.Name -> obf:`
 * - Field: `    type fieldName -> obf`
 * - Method: `    line:line:returnType methodName(args) -> obf`
 */
export function parseMojangMappings(text: string): MojangMappings {
  const mappings: MojangMappings = {
    classes: new Map(),
  };

  const lines = text.split('\n');
  let currentClass: MojangClassMapping | null = null;

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line.trim() === '') continue;

    // Class mapping (no leading whitespace, ends with :)
    if (!line.startsWith(' ') && line.includes(' -> ') && line.endsWith(':')) {
      const match = line.match(/^(.+) -> (.+):$/);
      if (match) {
        const deobf = capture(match, 1, 'Mojang class mapping').trim();
        const obf = capture(match, 2, 'Mojang class mapping').trim();

        currentClass = {
          deobfuscated: deobf,
          obfuscated: obf,
          methods: new Map(),
          fields: new Map(),
        };
        mappings.classes.set(deobf, currentClass);
      }
      continue;
    }

    // Member mapping (has leading whitespace)
    if (currentClass && line.startsWith('    ')) {
      const memberLine = line.trim();

      if (memberLine.includes('(')) {
        // Method: line:line:returnType methodName(args) -> obf
        // OR: returnType methodName(args) -> obf
        const methodMatch = memberLine.match(
          /^(?:\d+:\d+:)?(.+?) ([a-zA-Z_$][a-zA-Z0-9_$]*)\(([^)]*)\) -> (.+)$/
        );
        if (methodMatch) {
          const returnType = capture(methodMatch, 1, 'Mojang method mapping');
          const methodName = capture(methodMatch, 2, 'Mojang method mapping');
          const args = capture(methodMatch, 3, 'Mojang method mapping');
          const obfName = capture(methodMatch, 4, 'Mojang method mapping');

          // Build a unique key for the method (name + args)
          const key = `${methodName}(${args})`;
          currentClass.methods.set(key, {
            deobfuscated: methodName,
            obfuscated: obfName,
            args,
            returnType,
          });
        }
      } else {
        // Field: type fieldName -> obf
        const fieldMatch = memberLine.match(/^(.+?) ([a-zA-Z_$][a-zA-Z0-9_$]*) -> (.+)$/);
        if (fieldMatch) {
          const fieldType = capture(fieldMatch, 1, 'Mojang field mapping');
          const fieldName = capture(fieldMatch, 2, 'Mojang field mapping');
          const obfName = capture(fieldMatch, 3, 'Mojang field mapping');

          currentClass.fields.set(fieldName, {
            deobfuscated: fieldName,
            obfuscated: obfName,
            type: fieldType,
          });
        }
      }
    }
  }

  return mappings;
}
