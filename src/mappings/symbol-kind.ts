/**
 * Symbol-kind detection for the `resolve_symbol` tool.
 *
 * Classifies a raw symbol from a crash log, decompiled code, or user input so
 * the service knows which column to resolve it against. First match wins; the
 * order below is significant (modern intermediary tokens would otherwise be
 * mistaken for 1.12.2 SRG params, and short readable names for notch tokens).
 */

export type SymbolKind =
  /** `m_46859_` / `f_46443_` / `p_46860_` — modern official-mappings intermediary; not indexed. */
  | 'modern-intermediary'
  /** `func_71410_x` — 1.12.2 SRG method. */
  | 'srg-method'
  /** `field_78443_a` — 1.12.2 SRG field. */
  | 'srg-field'
  /** `p_i46742_2_` — 1.12.2 SRG constructor parameter. */
  | 'srg-ctor-param'
  /** `p_70080_1_` — 1.12.2 SRG method parameter. */
  | 'srg-param'
  /** `aab`, `bhy$a` — obfuscated (notch) token. */
  | 'notch'
  /** Anything else: a readable class/member name. */
  | 'readable';

const MODERN_INTERMEDIARY = /^[mfp]_\d+_$/;
const SRG_METHOD = /^func_\d+_[a-zA-Z]+_?$/;
const SRG_FIELD = /^field_\d+_[a-zA-Z]+_?$/;
const SRG_CTOR_PARAM = /^p_i\d+_\d+_$/;
const SRG_PARAM = /^p_\d+_\d+_$/;
const NOTCH = /^[a-zA-Z]{1,3}(\$[a-zA-Z0-9]{1,3})*$/;

export function detectSymbolKind(symbol: string): SymbolKind {
  if (MODERN_INTERMEDIARY.test(symbol)) {
    return 'modern-intermediary';
  }
  if (SRG_METHOD.test(symbol)) {
    return 'srg-method';
  }
  if (SRG_FIELD.test(symbol)) {
    return 'srg-field';
  }
  if (SRG_CTOR_PARAM.test(symbol)) {
    return 'srg-ctor-param';
  }
  if (SRG_PARAM.test(symbol)) {
    return 'srg-param';
  }
  if (NOTCH.test(symbol)) {
    return 'notch';
  }
  return 'readable';
}

/** Extract the numeric SRG id from `func_123_a` / `field_123_a` / `p_123_1_` / `p_i123_1_`. */
export function extractSrgId(symbol: string): number | null {
  const match = symbol.match(/^(?:func|field|p)_i?(\d+)_/);
  const id = match?.[1];
  return id ? Number.parseInt(id, 10) : null;
}
