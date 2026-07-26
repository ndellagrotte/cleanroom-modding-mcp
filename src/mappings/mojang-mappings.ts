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
