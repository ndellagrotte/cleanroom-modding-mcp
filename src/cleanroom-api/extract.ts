/**
 * Pass 1 of the Cleanroom API indexing pipeline: per-file extraction.
 *
 * Walks a tree-sitter-java parse tree into the plain ExtractedFile model —
 * package, imports, type declarations (recursively, with nesting chains),
 * members, modifiers, annotations, and attached Javadoc. Purely syntactic:
 * cross-file name resolution happens in resolve.ts.
 *
 * Error tolerance (DESIGN.md §8 Phase 3): files with syntax errors still yield
 * whatever declarations parsed; callers count them via ExtractedFile.parseErrors.
 */

import type {
  ExtractedFile,
  ExtractedMember,
  ExtractedParam,
  ExtractedType,
  ImportMap,
  JavadocInfo,
  JavaParser,
  MemberKind,
  TsNode,
  TypeKind,
} from './model.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests)
// ─────────────────────────────────────────────────────────────────────────────

const CAMEL_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g;

/** 'RightClickBlock' -> ['right','click','block']; 'NBTTagCompound' -> ['nbt','tag','compound']. */
export function splitCamel(name: string): string[] {
  const matches = name.match(CAMEL_RE);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

/**
 * Strip generic type arguments and array suffixes from a type reference:
 * 'GenericEvent<T>' -> 'GenericEvent', 'Map<K, List<V>>[]' -> 'Map'.
 */
export function stripTypeArgs(raw: string): string {
  let depth = 0;
  let out = '';
  for (const ch of raw) {
    if (ch === '<') {
      depth++;
    } else if (ch === '>') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out.replace(/\[\s*\]/g, '').trim();
}

/** Collapse all whitespace runs to single spaces. */
export function normalizeSignature(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Build the lower-cased token bag FTS matches against. Each part contributes
 * both its whole lower-cased words and their camel-split components, deduped.
 */
export function buildSearchText(parts: Array<string | null | undefined>): string {
  const tokens = new Set<string>();
  for (const part of parts) {
    if (!part) {
      continue;
    }
    for (const word of part.split(/[^A-Za-z0-9]+/)) {
      if (!word) {
        continue;
      }
      tokens.add(word.toLowerCase());
      for (const sub of splitCamel(word)) {
        tokens.add(sub);
      }
    }
  }
  return [...tokens].join(' ');
}

const INLINE_TAG_RE = /\{@(?:link|linkplain|code|literal|value)\s*([^}]*)\}/g;

/**
 * Parse a raw javadoc block comment into a cleaned body, first
 * sentence, and the @deprecated/@since tags. All other block tags are dropped.
 */
export function parseJavadoc(raw: string): JavadocInfo | null {
  let text = raw.trim();
  if (!text.startsWith('/**')) {
    return null;
  }
  text = text.replace(/^\/\*\*/, '').replace(/\*\/$/, '');

  const lines = text.split('\n').map((line) => line.replace(/^\s*\*? ?/, '').trimEnd());

  const bodyLines: string[] = [];
  let deprecatedNote: string | null = null;
  let since: string | null = null;
  // Block tags run until the next tag; we only keep @deprecated and @since.
  let currentTag: 'deprecated' | 'since' | 'other' | null = null;
  for (const line of lines) {
    const tagMatch = line.match(/^@(\w+)\s*(.*)$/);
    if (tagMatch) {
      const [, tag, rest] = tagMatch;
      if (tag === 'deprecated') {
        currentTag = 'deprecated';
        deprecatedNote = rest;
      } else if (tag === 'since') {
        currentTag = 'since';
        since = rest;
      } else {
        currentTag = 'other';
      }
      continue;
    }
    if (currentTag === 'deprecated') {
      deprecatedNote = `${deprecatedNote ?? ''} ${line}`.trim();
    } else if (currentTag === null) {
      bodyLines.push(line);
    }
    // 'since' and 'other' continuation lines are dropped.
  }

  const clean = (s: string): string => normalizeSignature(s.replace(INLINE_TAG_RE, '$1'));

  const body = clean(bodyLines.join('\n'));
  const sentenceMatch = body.match(/^(.*?[.!?])(?:\s|$)/);
  const summary = sentenceMatch ? sentenceMatch[1] : body;

  return {
    body,
    summary,
    deprecatedNote: deprecatedNote !== null ? clean(deprecatedNote) : null,
    since: since !== null ? clean(since) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree walking
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_DECLARATION_KINDS: Record<string, TypeKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  annotation_type_declaration: 'annotation',
  record_declaration: 'record',
};

const KIND_KEYWORD: Record<TypeKind, string> = {
  class: 'class',
  interface: 'interface',
  enum: 'enum',
  annotation: '@interface',
  record: 'record',
};

const MODIFIER_KEYWORDS = new Set([
  'public',
  'protected',
  'private',
  'abstract',
  'static',
  'final',
  'strictfp',
  'default',
  'synchronized',
  'native',
  'transient',
  'volatile',
  'sealed',
  'non-sealed',
]);

function childOfType(node: TsNode, type: string): TsNode | null {
  return node.namedChildren.find((c) => c.type === type) ?? null;
}

/** Split a `modifiers` node into keyword modifiers and annotation names ('@' stripped). */
function readModifiers(node: TsNode | null): { modifiers: string[]; annotations: string[] } {
  const modifiers: string[] = [];
  const annotations: string[] = [];
  if (node) {
    for (const child of node.children) {
      if (child.type === 'marker_annotation' || child.type === 'annotation') {
        const name = child.childForFieldName('name');
        if (name) {
          annotations.push(name.text);
        }
      } else if (MODIFIER_KEYWORDS.has(child.type)) {
        modifiers.push(child.type);
      }
    }
  }
  return { modifiers, annotations };
}

/**
 * The javadoc for a declaration is the nearest preceding block comment starting
 * with '/**', tolerating intervening line comments.
 */
function findJavadoc(node: TsNode): JavadocInfo | null {
  let prev = node.previousNamedSibling;
  while (prev && prev.type === 'line_comment') {
    prev = prev.previousNamedSibling;
  }
  if (prev && prev.type === 'block_comment' && prev.text.startsWith('/**')) {
    return parseJavadoc(prev.text);
  }
  return null;
}

function isDeprecatedDecl(annotations: string[], javadoc: JavadocInfo | null): boolean {
  return annotations.includes('Deprecated') || javadoc?.deprecatedNote != null;
}

function readParams(parametersNode: TsNode | null): ExtractedParam[] {
  const params: ExtractedParam[] = [];
  if (!parametersNode) {
    return params;
  }
  for (const child of parametersNode.namedChildren) {
    if (child.type === 'formal_parameter') {
      const type = child.childForFieldName('type')?.text ?? '?';
      const name = child.childForFieldName('name')?.text ?? '?';
      const dims = child.childForFieldName('dimensions')?.text ?? '';
      params.push({ type: normalizeSignature(type + dims), name });
    } else if (child.type === 'spread_parameter') {
      // Structure: (modifiers)? type '...' variable_declarator
      const declarator = childOfType(child, 'variable_declarator');
      const name = declarator?.childForFieldName('name')?.text ?? '?';
      const typeNode = child.namedChildren.find(
        (c) => c !== declarator && c.type !== 'modifiers' && !c.type.endsWith('comment')
      );
      params.push({ type: normalizeSignature(`${typeNode?.text ?? '?'}...`), name });
    }
    // receiver_parameter carries no name; irrelevant for an API index.
  }
  return params;
}

function formatParams(params: ExtractedParam[]): string {
  return `(${params.map((p) => `${p.type} ${p.name}`).join(', ')})`;
}

function makeMember(
  kind: MemberKind,
  name: string,
  signature: string,
  returnType: string | null,
  params: ExtractedParam[] | null,
  modifiers: string[],
  annotations: string[],
  javadoc: JavadocInfo | null,
  declaringTypeName: string
): ExtractedMember {
  return {
    kind,
    name,
    signature: normalizeSignature(signature),
    returnType,
    params,
    modifiers,
    annotations,
    javadoc,
    isDeprecated: isDeprecatedDecl(annotations, javadoc),
    since: javadoc?.since ?? null,
    searchText: buildSearchText([name, declaringTypeName, returnType]),
  };
}

/** Extract the members declared directly in a type body node. */
function extractMembers(bodyNode: TsNode, declaringTypeName: string): ExtractedMember[] {
  const members: ExtractedMember[] = [];

  const visitBodyChild = (child: TsNode): void => {
    switch (child.type) {
      case 'method_declaration': {
        const { modifiers, annotations } = readModifiers(childOfType(child, 'modifiers'));
        const javadoc = findJavadoc(child);
        const name = child.childForFieldName('name')?.text ?? '?';
        const typeParams = child.childForFieldName('type_parameters')?.text;
        const dims = child.childForFieldName('dimensions')?.text ?? '';
        const returnType = normalizeSignature(
          (child.childForFieldName('type')?.text ?? 'void') + dims
        );
        const params = readParams(child.childForFieldName('parameters'));
        const throwsText = childOfType(child, 'throws')?.text;
        const signature = [
          modifiers.join(' '),
          typeParams,
          returnType,
          `${name}${formatParams(params)}`,
          throwsText,
        ]
          .filter(Boolean)
          .join(' ');
        members.push(
          makeMember(
            'method',
            name,
            signature,
            returnType,
            params,
            modifiers,
            annotations,
            javadoc,
            declaringTypeName
          )
        );
        break;
      }

      case 'constructor_declaration':
      case 'compact_constructor_declaration': {
        const { modifiers, annotations } = readModifiers(childOfType(child, 'modifiers'));
        const javadoc = findJavadoc(child);
        const name = child.childForFieldName('name')?.text ?? '?';
        const params =
          child.type === 'constructor_declaration'
            ? readParams(child.childForFieldName('parameters'))
            : [];
        const throwsText = childOfType(child, 'throws')?.text;
        const signature = [modifiers.join(' '), `${name}${formatParams(params)}`, throwsText]
          .filter(Boolean)
          .join(' ');
        members.push(
          makeMember(
            'constructor',
            name,
            signature,
            null,
            params,
            modifiers,
            annotations,
            javadoc,
            declaringTypeName
          )
        );
        break;
      }

      case 'field_declaration':
      case 'constant_declaration': {
        const { modifiers, annotations } = readModifiers(childOfType(child, 'modifiers'));
        const javadoc = findJavadoc(child);
        const type = normalizeSignature(child.childForFieldName('type')?.text ?? '?');
        // One member per declarator: `public static int A, B;` yields two fields.
        for (const declarator of child.namedChildren.filter(
          (c) => c.type === 'variable_declarator'
        )) {
          const name = declarator.childForFieldName('name')?.text ?? '?';
          const dims = declarator.childForFieldName('dimensions')?.text ?? '';
          const fieldType = normalizeSignature(type + dims);
          const signature = [modifiers.join(' '), fieldType, name].filter(Boolean).join(' ');
          members.push(
            makeMember(
              'field',
              name,
              signature,
              fieldType,
              null,
              modifiers,
              annotations,
              javadoc,
              declaringTypeName
            )
          );
        }
        break;
      }

      case 'enum_constant': {
        const { modifiers, annotations } = readModifiers(childOfType(child, 'modifiers'));
        const javadoc = findJavadoc(child);
        const name = child.childForFieldName('name')?.text ?? '?';
        members.push(
          makeMember(
            'enum_constant',
            name,
            name,
            null,
            null,
            modifiers,
            annotations,
            javadoc,
            declaringTypeName
          )
        );
        break;
      }

      case 'annotation_type_element_declaration': {
        const { modifiers, annotations } = readModifiers(childOfType(child, 'modifiers'));
        const javadoc = findJavadoc(child);
        const name = child.childForFieldName('name')?.text ?? '?';
        const type = normalizeSignature(child.childForFieldName('type')?.text ?? '?');
        const defaultValue = child.childForFieldName('value')?.text;
        const signature =
          `${type} ${name}()` +
          (defaultValue ? ` default ${normalizeSignature(defaultValue)}` : '');
        members.push(
          makeMember(
            'annotation_element',
            name,
            signature,
            type,
            null,
            modifiers,
            annotations,
            javadoc,
            declaringTypeName
          )
        );
        break;
      }

      case 'enum_body_declarations': {
        // Members after the constant list live one level deeper.
        for (const inner of child.namedChildren) {
          visitBodyChild(inner);
        }
        break;
      }

      default:
        break;
    }
  };

  for (const child of bodyNode.namedChildren) {
    visitBodyChild(child);
  }
  return members;
}

function extractType(
  node: TsNode,
  kind: TypeKind,
  parentChain: string[],
  packageName: string
): ExtractedType | null {
  const simpleName = node.childForFieldName('name')?.text;
  if (!simpleName) {
    return null;
  }
  const nestedChain = [...parentChain, simpleName];
  const { modifiers, annotations } = readModifiers(childOfType(node, 'modifiers'));
  const javadoc = findJavadoc(node);
  const typeParams = node.childForFieldName('type_parameters')?.text ?? null;

  // Classes: `superclass` field node reads 'extends X'.
  const superclassNode = node.childForFieldName('superclass');
  const extendsRaw = superclassNode
    ? normalizeSignature(superclassNode.namedChildren[0]?.text ?? '')
    : null;

  // Classes/enums/records: `interfaces` field ('implements A, B').
  // Interfaces: `extends_interfaces` child ('extends A, B') — stored in
  // implementsRaw for uniformity; the signature keeps the true keyword.
  const implementsRaw: string[] = [];
  const interfacesNode =
    node.childForFieldName('interfaces') ?? childOfType(node, 'extends_interfaces');
  if (interfacesNode) {
    const typeList = childOfType(interfacesNode, 'type_list');
    for (const t of typeList?.namedChildren ?? []) {
      implementsRaw.push(normalizeSignature(t.text));
    }
  }

  const recordParams =
    kind === 'record'
      ? normalizeSignature(node.childForFieldName('parameters')?.text ?? '()')
      : null;

  const signatureParts = [
    modifiers.join(' '),
    KIND_KEYWORD[kind],
    `${simpleName}${typeParams ?? ''}${recordParams ?? ''}`,
  ];
  if (extendsRaw) {
    signatureParts.push(`extends ${extendsRaw}`);
  }
  if (implementsRaw.length > 0) {
    signatureParts.push(
      `${kind === 'interface' ? 'extends' : 'implements'} ${implementsRaw.join(', ')}`
    );
  }
  const signature = normalizeSignature(signatureParts.filter(Boolean).join(' '));

  const bodyNode = node.childForFieldName('body');
  const members = bodyNode ? extractMembers(bodyNode, simpleName) : [];
  const children: ExtractedType[] = [];
  if (bodyNode) {
    collectTypeDeclarations(bodyNode, nestedChain, packageName, children);
  }

  const packageSegments = packageName.split('.');
  const searchText = buildSearchText([
    simpleName,
    nestedChain.join(' '),
    kind,
    ...packageSegments.slice(-2),
    extendsRaw ? stripTypeArgs(extendsRaw) : null,
    ...implementsRaw.map(stripTypeArgs),
  ]);

  return {
    simpleName,
    nestedChain,
    kind,
    modifiers,
    annotations,
    typeParams,
    extendsRaw: extendsRaw || null,
    implementsRaw,
    javadoc,
    isDeprecated: isDeprecatedDecl(annotations, javadoc),
    since: javadoc?.since ?? null,
    signature,
    searchText,
    members,
    children,
  };
}

/** Collect type declarations among a node's named children (recursing via extractType). */
function collectTypeDeclarations(
  container: TsNode,
  parentChain: string[],
  packageName: string,
  out: ExtractedType[]
): void {
  for (const child of container.namedChildren) {
    const kind = TYPE_DECLARATION_KINDS[child.type];
    if (kind) {
      const extracted = extractType(child, kind, parentChain, packageName);
      if (extracted) {
        out.push(extracted);
      }
    } else if (child.type === 'enum_body_declarations') {
      collectTypeDeclarations(child, parentChain, packageName, out);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract one Java source file. Returns null when the file has no package
 * declaration or fails to parse entirely (callers count skips).
 */
export function extractFile(
  parser: JavaParser,
  source: string,
  sourceFile: string
): ExtractedFile | null {
  const tree = parser.parse(source);
  if (!tree) {
    return null;
  }
  const root = tree.rootNode;

  const packageNode = childOfType(root, 'package_declaration');
  const packageName = packageNode?.namedChildren
    .filter((c) => c.type === 'identifier' || c.type === 'scoped_identifier')
    .pop()?.text;
  if (!packageName) {
    return null;
  }

  const imports: ImportMap = { explicit: {}, wildcards: [] };
  for (const child of root.namedChildren) {
    if (child.type !== 'import_declaration') {
      continue;
    }
    const target = child.namedChildren
      .filter((c) => c.type === 'identifier' || c.type === 'scoped_identifier')
      .pop()?.text;
    if (!target) {
      continue;
    }
    const isWildcard = child.children.some((c) => c.type === 'asterisk');
    if (isWildcard) {
      imports.wildcards.push(target);
    } else {
      const simple = target.split('.').pop();
      if (simple) {
        imports.explicit[simple] = target;
      }
    }
  }

  const types: ExtractedType[] = [];
  collectTypeDeclarations(root, [], packageName, types);

  return {
    path: sourceFile,
    packageName,
    imports,
    types,
    parseErrors: root.hasError,
  };
}
