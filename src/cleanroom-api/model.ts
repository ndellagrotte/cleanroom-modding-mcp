/**
 * Shared data model for the Cleanroom API indexing pipeline:
 * extract (pass 1, per-file) -> resolve (pass 2, corpus-wide) -> ingest.
 *
 * Deliberately free of web-tree-sitter types so nothing here (or in emitted
 * .d.ts files) references that devDependency — the runtime server never loads
 * the parser.
 */

import type { Loader } from '../loaders.js';

export type TypeKind = 'class' | 'interface' | 'enum' | 'annotation' | 'record';

export type MemberKind =
  | 'method'
  | 'constructor'
  | 'field'
  | 'enum_constant'
  | 'annotation_element';

/**
 * Minimal structural view of a tree-sitter syntax node. web-tree-sitter's Node
 * satisfies this shape; keeping our own interface keeps the parser dependency
 * out of every public signature.
 */
export interface TsNode {
  type: string;
  text: string;
  hasError: boolean;
  children: TsNode[];
  namedChildren: TsNode[];
  previousNamedSibling: TsNode | null;
  childForFieldName(fieldName: string): TsNode | null;
}

/** Structural view of a parser bound to the Java language. */
export interface JavaParser {
  /** The returned tree owns WASM linear memory; call delete() when done. */
  parse(source: string): { rootNode: TsNode; delete(): void } | null;
}

export interface JavadocInfo {
  /** Cleaned body: comment markers stripped, block tags (@param, ...) removed. */
  body: string;
  /** First sentence of the body. */
  summary: string;
  /** Text of the @deprecated tag, if present ('' when the tag is bare). */
  deprecatedNote: string | null;
  /** Value of the @since tag, if present. */
  since: string | null;
}

export interface ImportMap {
  /** simple name -> fully qualified name, from explicit imports. */
  explicit: Record<string, string>;
  /** package prefixes from wildcard imports (without the trailing '.*'). */
  wildcards: string[];
}

export interface ExtractedParam {
  type: string;
  name: string;
}

export interface ExtractedMember {
  kind: MemberKind;
  name: string;
  /** Normalized readable signature, e.g. 'public static void register(Class<?> clazz)'. */
  signature: string;
  /** Return/field/element type; null for constructors and enum constants. */
  returnType: string | null;
  /** Parameters for methods/constructors; null otherwise. */
  params: ExtractedParam[] | null;
  modifiers: string[];
  /** Annotation names as written, '@' stripped ('Deprecated', 'SideOnly'). */
  annotations: string[];
  javadoc: JavadocInfo | null;
  isDeprecated: boolean;
  since: string | null;
  searchText: string;
}

export interface ExtractedType {
  simpleName: string;
  /** Nesting chain from the top-level type down, e.g. ['PlayerInteractEvent','RightClickBlock']. */
  nestedChain: string[];
  kind: TypeKind;
  modifiers: string[];
  annotations: string[];
  /** '<T extends IForgeRegistryEntry<T>>' or null. */
  typeParams: string | null;
  /** extends clause as written (classes only), incl. type args. */
  extendsRaw: string | null;
  /** implements clause entries as written; interface 'extends' lists land here too. */
  implementsRaw: string[];
  javadoc: JavadocInfo | null;
  isDeprecated: boolean;
  since: string | null;
  /** Normalized declaration line. */
  signature: string;
  searchText: string;
  members: ExtractedMember[];
  /** Nested type declarations. */
  children: ExtractedType[];
}

export interface ExtractedFile {
  /** Jar-relative path, e.g. 'net/minecraftforge/common/MinecraftForge.java'. */
  path: string;
  packageName: string;
  imports: ImportMap;
  types: ExtractedType[];
  /** True when tree-sitter reported syntax errors (extraction is best-effort then). */
  parseErrors: boolean;
}

/** A type flattened by pass 2 with resolved names and catalog flags. */
export interface ResolvedType {
  fqn: string;
  simpleName: string;
  packageName: string;
  outerFqn: string | null;
  kind: TypeKind;
  loader: Loader;
  modifiers: string;
  signature: string;
  extendsRaw: string | null;
  extendsFqn: string | null;
  implementsRaw: string[];
  implementsFqns: string[];
  annotations: string[];
  javadoc: string | null;
  javadocSummary: string | null;
  isDeprecated: boolean;
  deprecationNote: string | null;
  since: string | null;
  isEvent: boolean;
  isCancelable: boolean;
  hasResult: boolean;
  sourceFile: string;
  searchText: string;
  members: ExtractedMember[];
  /** 0 for top-level types; used to insert parents before children. */
  nestingDepth: number;
}

export interface ResolveStats {
  totalTypes: number;
  totalMembers: number;
  resolvedParents: number;
  unresolvedParents: number;
  events: number;
  annotationTypes: number;
}

export interface ResolveResult {
  types: ResolvedType[];
  /** Corpus-defined annotation FQN -> number of usages across all declarations. */
  annotationUsage: Map<string, number>;
  stats: ResolveStats;
}
