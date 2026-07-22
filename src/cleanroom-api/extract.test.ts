/**
 * Unit tests for pass-1 extraction over inline Java fixtures.
 * Loads the real tree-sitter-java wasm (devDependency) — no database needed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createJavaParser } from './java-parser.js';
import {
  buildSearchText,
  extractFile,
  normalizeSignature,
  parseJavadoc,
  splitCamel,
  stripTypeArgs,
} from './extract.js';
import type { ExtractedFile, JavaParser } from './model.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('splitCamel', () => {
  it.each([
    ['RightClickBlock', ['right', 'click', 'block']],
    ['NBTTagCompound', ['nbt', 'tag', 'compound']],
    ['getStateFromMeta', ['get', 'state', 'from', 'meta']],
    ['lowercase', ['lowercase']],
    ['HTTP2Connection', ['http', '2', 'connection']],
    ['', []],
  ])('%s -> %j', (input, expected) => {
    expect(splitCamel(input)).toEqual(expected);
  });
});

describe('stripTypeArgs', () => {
  it.each([
    ['GenericEvent<T>', 'GenericEvent'],
    ['Map<K, List<V>>', 'Map'],
    ['Map<K, List<V>>[]', 'Map'],
    ['String', 'String'],
    ['int[]', 'int'],
    ['Outer.Inner<T>', 'Outer.Inner'],
  ])('%s -> %s', (input, expected) => {
    expect(stripTypeArgs(input)).toBe(expected);
  });
});

describe('normalizeSignature', () => {
  it('collapses whitespace runs', () => {
    expect(normalizeSignature('public   static\n  void  run()')).toBe('public static void run()');
  });
});

describe('buildSearchText', () => {
  it('contains whole tokens and camel components, lower-cased and deduped', () => {
    const text = buildSearchText(['RightClickBlock', 'PlayerInteractEvent']);
    const tokens = text.split(' ');
    for (const expected of [
      'rightclickblock',
      'right',
      'click',
      'block',
      'playerinteractevent',
      'player',
      'interact',
      'event',
    ]) {
      expect(tokens).toContain(expected);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('parseJavadoc', () => {
  it('extracts body, summary, and tags', () => {
    const info = parseJavadoc(
      '/**\n' +
        ' * Registers a config class. Called early.\n' +
        ' * Second sentence here.\n' +
        ' *\n' +
        ' * @param clazz the config class\n' +
        ' * @deprecated use {@link ConfigAnytime#register} instead,\n' +
        ' *             it handles everything\n' +
        ' * @since 0.5.0\n' +
        ' */'
    );
    expect(info).not.toBeNull();
    expect(info?.summary).toBe('Registers a config class.');
    expect(info?.body).toContain('Second sentence here.');
    expect(info?.body).not.toContain('@param');
    expect(info?.deprecatedNote).toBe('use ConfigAnytime#register instead, it handles everything');
    expect(info?.since).toBe('0.5.0');
  });

  it('returns null for non-javadoc comments', () => {
    expect(parseJavadoc('/* plain block comment */')).toBeNull();
  });

  it('handles a bare @deprecated tag', () => {
    const info = parseJavadoc('/** Old thing.\n * @deprecated\n */');
    expect(info?.deprecatedNote).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tree extraction over fixtures
// ─────────────────────────────────────────────────────────────────────────────

let parser: JavaParser;

beforeAll(async () => {
  parser = await createJavaParser();
});

function extract(source: string, path = 'com/example/Fixture.java'): ExtractedFile {
  const file = extractFile(parser, source, path);
  expect(file).not.toBeNull();
  return file as ExtractedFile;
}

describe('extractFile', () => {
  it('reads package, explicit imports, and wildcard imports', () => {
    const file = extract(
      `package com.example;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.event.entity.player.*;
import static java.util.Objects.requireNonNull;
public class Thing {}
`
    );
    expect(file.packageName).toBe('com.example');
    expect(file.imports.explicit['Mod']).toBe('net.minecraftforge.fml.common.Mod');
    expect(file.imports.wildcards).toContain('net.minecraftforge.event.entity.player');
    expect(file.types).toHaveLength(1);
    expect(file.types[0].kind).toBe('class');
    expect(file.parseErrors).toBe(false);
  });

  it('returns null when there is no package declaration', () => {
    expect(extractFile(parser, 'public class NoPackage {}', 'NoPackage.java')).toBeNull();
  });

  it('extracts class declaration details: modifiers, generics, extends, implements', () => {
    const file = extract(
      `package com.example;
public abstract class RegistryEvent<T extends Comparable<T>> extends GenericEvent<T> implements Cloneable, java.io.Serializable {
}
`
    );
    const type = file.types[0];
    expect(type.simpleName).toBe('RegistryEvent');
    expect(type.modifiers).toEqual(['public', 'abstract']);
    expect(type.typeParams).toBe('<T extends Comparable<T>>');
    expect(type.extendsRaw).toBe('GenericEvent<T>');
    expect(type.implementsRaw).toEqual(['Cloneable', 'java.io.Serializable']);
    expect(type.signature).toBe(
      'public abstract class RegistryEvent<T extends Comparable<T>> extends GenericEvent<T> implements Cloneable, java.io.Serializable'
    );
  });

  it('maps interface extends into implementsRaw but keeps the extends keyword in the signature', () => {
    const file = extract(
      `package com.example;
public interface Child extends ParentA, ParentB {}
`
    );
    const type = file.types[0];
    expect(type.kind).toBe('interface');
    expect(type.implementsRaw).toEqual(['ParentA', 'ParentB']);
    expect(type.signature).toBe('public interface Child extends ParentA, ParentB');
  });

  it('attaches javadoc and detects both deprecation forms', () => {
    const file = extract(
      `package com.example;
/**
 * A very old interface.
 * @deprecated implement the manifest attribute instead
 */
@Deprecated
public interface OldLoader {}

/** Doc-only deprecation.
 * @deprecated gone
 */
public interface DocDeprecated {}

@Deprecated
public interface AnnotationDeprecated {}
`
    );
    const [old, doc, anno] = file.types;
    expect(old.javadoc?.summary).toBe('A very old interface.');
    expect(old.isDeprecated).toBe(true);
    expect(old.javadoc?.deprecatedNote).toBe('implement the manifest attribute instead');
    expect(old.annotations).toContain('Deprecated');
    expect(doc.isDeprecated).toBe(true);
    expect(anno.isDeprecated).toBe(true);
    expect(anno.javadoc).toBeNull();
  });

  it('extracts nested types with chains', () => {
    const file = extract(
      `package com.example;
public class Outer {
  public static class Middle {
    public static class Inner {}
  }
  public @interface Marker {}
}
`
    );
    const outer = file.types[0];
    expect(outer.children.map((c) => c.simpleName).sort()).toEqual(['Marker', 'Middle']);
    const middle = outer.children.find((c) => c.simpleName === 'Middle');
    expect(middle?.children[0].nestedChain).toEqual(['Outer', 'Middle', 'Inner']);
    const marker = outer.children.find((c) => c.simpleName === 'Marker');
    expect(marker?.kind).toBe('annotation');
  });

  it('extracts methods with params, throws, varargs, and generics', () => {
    const file = extract(
      `package com.example;
public class Api {
  /** Adds an entry. */
  public static <T extends Enum<T>> T addEnumEntry(Class<T> clazz, String name, Object... params) throws IllegalStateException {
    return null;
  }
}
`
    );
    const method = file.types[0].members[0];
    expect(method.kind).toBe('method');
    expect(method.name).toBe('addEnumEntry');
    expect(method.returnType).toBe('T');
    expect(method.params).toEqual([
      { type: 'Class<T>', name: 'clazz' },
      { type: 'String', name: 'name' },
      { type: 'Object...', name: 'params' },
    ]);
    expect(method.signature).toBe(
      'public static <T extends Enum<T>> T addEnumEntry(Class<T> clazz, String name, Object... params) throws IllegalStateException'
    );
    expect(method.javadoc?.summary).toBe('Adds an entry.');
  });

  it('extracts constructors', () => {
    const file = extract(
      `package com.example;
public class Widget {
  public Widget(int size) {}
}
`
    );
    const ctor = file.types[0].members[0];
    expect(ctor.kind).toBe('constructor');
    expect(ctor.name).toBe('Widget');
    expect(ctor.returnType).toBeNull();
    expect(ctor.signature).toBe('public Widget(int size)');
  });

  it('keeps type parameters on generic constructors', () => {
    const file = extract(
      `package com.example;
public class State {
  public <M extends Comparable<M>, S> State(M first, S second) {}
}
`
    );
    const ctor = file.types[0].members[0];
    expect(ctor.kind).toBe('constructor');
    expect(ctor.signature).toBe('public <M extends Comparable<M>, S> State(M first, S second)');
  });

  it('recovers varargs parameters of the `Type @Anno ... name` form', () => {
    // tree-sitter-java 0.23.5 cannot parse a type-use annotation before the
    // ellipsis and yields an ERROR node; the extractor recovers the parameter
    // from the raw text so the declaration keeps its arity.
    const file = extract(
      `package com.example;
public class Vao {
  public Vao(String layout, Integer view, Float @Deprecated ... views) {}
  public void update(Handle @Deprecated ... handles) {}
}
`
    );
    const ctor = file.types[0].members[0];
    expect(ctor.params).toEqual([
      { type: 'String', name: 'layout' },
      { type: 'Integer', name: 'view' },
      { type: 'Float...', name: 'views' },
    ]);
    expect(ctor.signature).toBe('public Vao(String layout, Integer view, Float... views)');
    const method = file.types[0].members[1];
    expect(method.params).toEqual([{ type: 'Handle...', name: 'handles' }]);
    expect(method.signature).toBe('public void update(Handle... handles)');
  });

  it('extracts the permits clause of sealed types into the signature and search text', () => {
    const file = extract(
      `package com.example;
public sealed interface WorldKind permits Graphics, Headless {}
`
    );
    const type = file.types[0];
    expect(type.signature).toBe('public sealed interface WorldKind permits Graphics, Headless');
    expect(type.searchText).toContain('graphics');
    expect(type.searchText).toContain('headless');
  });

  it('strips javadoc HTML tags from the summary but keeps the body intact', () => {
    const file = extract(
      `package com.example;
public class Store {
  /**
   * A buffer storage consists of pages.
   * <p>Every page should be huge in size.</p>
   */
  public void allocate() {}
  /** <p>Prerequisite include:</p> <ul><li>registered</li></ul> */
  public void register() {}
}
`
    );
    const [allocate, register] = file.types[0].members;
    expect(allocate.javadoc?.summary).toBe('A buffer storage consists of pages.');
    expect(allocate.javadoc?.body).toContain('<p>');
    expect(register.javadoc?.summary).not.toContain('<');
  });

  it('splits multi-variable field declarations into one member each', () => {
    const file = extract(
      `package com.example;
public class Flags {
  /** Shared doc. */
  public static final int A = 1, B = 2;
  private String name;
}
`
    );
    const members = file.types[0].members;
    expect(members.map((m) => m.name)).toEqual(['A', 'B', 'name']);
    expect(members[0].returnType).toBe('int');
    expect(members[0].signature).toBe('public static final int A');
    expect(members[0].javadoc?.summary).toBe('Shared doc.');
    expect(members[1].javadoc?.summary).toBe('Shared doc.');
    expect(members[2].signature).toBe('private String name');
  });

  it('extracts enum constants and members after the constant list', () => {
    const file = extract(
      `package com.example;
public enum Side {
  /** The client. */
  CLIENT,
  SERVER;

  public boolean isClient() { return this == CLIENT; }
}
`
    );
    const type = file.types[0];
    expect(type.kind).toBe('enum');
    const constants = type.members.filter((m) => m.kind === 'enum_constant');
    expect(constants.map((c) => c.name)).toEqual(['CLIENT', 'SERVER']);
    expect(constants[0].javadoc?.summary).toBe('The client.');
    expect(type.members.some((m) => m.kind === 'method' && m.name === 'isClient')).toBe(true);
  });

  it('extracts annotation elements with defaults', () => {
    const file = extract(
      `package com.example;
public @interface Mod {
  String modid();
  String version() default "";
  boolean useMetadata() default false;
}
`
    );
    const elements = file.types[0].members;
    expect(elements).toHaveLength(3);
    expect(elements.every((e) => e.kind === 'annotation_element')).toBe(true);
    expect(elements[1].signature).toBe('String version() default ""');
    expect(elements[1].returnType).toBe('String');
  });

  it('extracts records', () => {
    const file = extract(
      `package com.example;
public record DiscoveredMod(String id, java.nio.file.Path path) {
  public boolean valid() { return id != null; }
}
`
    );
    const type = file.types[0];
    expect(type.kind).toBe('record');
    expect(type.signature).toContain('record DiscoveredMod(String id, java.nio.file.Path path)');
    expect(type.members.some((m) => m.name === 'valid')).toBe(true);
  });

  it('collects annotation names with arguments and qualified names', () => {
    const file = extract(
      `package com.example;
@Mod.EventBusSubscriber(modid = "x")
@SideOnly(Side.CLIENT)
@Cancelable
public class Handler {}
`
    );
    expect(file.types[0].annotations).toEqual(['Mod.EventBusSubscriber', 'SideOnly', 'Cancelable']);
  });

  it('still extracts parseable declarations from a file with syntax errors', () => {
    const file = extract(
      `package com.example;
public class Good { public void ok() {} }
public class Broken { this is not java at all %%%
`
    );
    expect(file.parseErrors).toBe(true);
    const good = file.types.find((t) => t.simpleName === 'Good');
    expect(good).toBeDefined();
    expect(good?.members.some((m) => m.name === 'ok')).toBe(true);
  });
});
