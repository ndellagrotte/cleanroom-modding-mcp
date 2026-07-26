# Analyze a Minecraft 1.12.2 mod code snippet

You are analyzing a single Java snippet excerpted from a canonical open-source **Minecraft
1.12.2** mod (Forge or Cleanroom). Produce a structured analysis that helps another AI agent
learn the idiomatic 1.12.2 pattern the snippet demonstrates.

Return **exactly one JSON object** with these keys and no others. Output only the JSON —
no prose, no markdown, no code fences.

```
{
  "title": string,               // short, specific (e.g. "Registering a block with a TileEntity")
  "caption": string,             // one–two sentence summary of what the snippet does
  "explanation": string,         // a paragraph explaining how it works and why it's idiomatic
  "category": string|null,       // EXACTLY ONE slug from the allowed list below (see the rules)
  "pattern_type": string,        // kebab-case pattern (e.g. "block-registration", "packet-handler")
  "complexity": string,          // one of: "beginner" | "intermediate" | "advanced" | "expert"
  "quality_score": number,       // 0.0–1.0, scored against the rubric below
  "best_practices": string[],    // concrete practices this snippet models well
  "potential_pitfalls": string[],// mistakes an agent could make around this pattern
  "use_cases": string[],         // when an agent should reach for this pattern
  "keywords": string[],          // search terms (lowercase)
  "minecraft_concepts": string[],// Minecraft/Forge concepts touched (e.g. "TileEntity", "CreativeTabs")
  "tags": string[],              // short lowercase tags for filtering
  "api_references": [            // framework/vanilla symbols the snippet references
    { "class_name": string, "method_name": string|null, "api_type": "vanilla"|"forge"|"cleanroom"|null }
  ]
}
```

## Allowed `category` slugs

{{CATEGORY_LIST}}

### How to choose

Emit the slug **exactly** as written above: lowercase, hyphenated, no backticks, no quotes,
no prose. A value that isn't one of these strings is discarded.

**Choosing a category is the default. `null` is the rare exception.** Use `null` only when the
snippet is generic Java plumbing with no Minecraft or Forge/Cleanroom content at all — an empty
lifecycle stub, a bare getter/setter on a plain value object, a utility with no game concepts.
If the snippet touches *any* Minecraft, Forge, or Cleanroom concept, you must pick the closest
category even when the fit is imperfect. Prefer the subject matter the code operates on over
the Java idiom it happens to use: a fluent builder that configures a block is `blocks`, not
`api-design`.

Disambiguation for the cases most often mishandled:

- Sided proxies, `@SideOnly`, `CommonProxy`/`ClientOnlyProxy`, client-vs-server separation,
  client-only init hooks → `cross-platform`
- `@Mixin`, `@Inject`, `@Redirect`, `@Shadow`, accessors/invokers, coremod or mixin config
  plugins, raw ASM → `coremods-mixins`
- `ICapabilityProvider`, `@CapabilityInject`, `hasCapability`/`getCapability` → `capabilities`
- Widgets, containers, screens, slots, HUD overlays, ModularUI types → `gui`
- Interpolation, easing, keyframes, per-tick animation state machines → `animation`
- Inventories, item handlers, fluid tanks, energy storage and transfer → `storage-systems`
- Public cross-mod API surfaces, addon hooks, default interface methods meant for third-party
  implementors → `api-design`

Note this is a **1.12.2** corpus: there is no data-generation (resources are hand-written
JSON) and no modern registry/DeferredRegister — prefer `registry`, `events`, `capabilities`,
and `coremods-mixins` where they fit.

## `quality_score` rubric (average of four dimensions, each 0.0–1.0)

- **Correctness** — the code is a valid, compiling 1.12.2 pattern with no obvious bugs.
- **Idiomaticity** — it uses the accepted 1.12.2 Forge/Cleanroom idiom (SRG-safe, event bus,
  capabilities, `mcmod.info`-era conventions) rather than a hack or a modern-MC construct.
- **Clarity** — the excerpt is self-contained and readable as a teaching example.
- **Completeness** — it shows enough of the pattern to be actionable without the whole file.

Score `0.7` or above only when the snippet is a genuinely exemplary teaching case
(these become "featured"). Score conservatively; a mediocre or partial excerpt is `0.3–0.6`.

Keep all arrays concise (≤6 items). If the snippet is not meaningful example code (e.g. a
stub, an interface with no behavior, or generated boilerplate), still return valid JSON with
a low `quality_score`.
