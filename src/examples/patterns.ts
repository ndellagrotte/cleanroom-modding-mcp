/** Deterministic normalization and clustering for LLM-produced pattern labels. */

export interface CanonicalPattern {
  alias: string;
  canonical: string;
}

type PatternRule = readonly [canonical: string, match: RegExp];

/**
 * Ordered from specific Minecraft concepts to general implementation shapes.
 * The final catch-all keeps the vocabulary bounded when a model invents a new
 * label. On the production corpus these rules produce 69 canonical values.
 */
const CANONICAL_PATTERN_RULES: readonly PatternRule[] = [
  ['capability-provider', /capabilit.*provider|provider.*capabilit/],
  ['capability-serialization', /capabilit.*(storage|serial|nbt)|(?:storage|serial|nbt).*capabilit/],
  ['capability-attachment', /capabilit.*(attach|register)|(?:attach|register).*capabilit/],
  ['capability-access', /capabilit/],
  ['mixin-accessor', /mixin.*(accessor|invoker)|(?:accessor|invoker).*mixin/],
  ['mixin-redirect', /mixin.*redirect|redirect.*mixin/],
  [
    'mixin-modification',
    /mixin.*(modify|overwrite|constant|expression|wrap)|(?:modify|overwrite).*mixin/,
  ],
  ['mixin-injection', /mixin|injection-point/],
  ['asm-transformer', /asm|bytecode|class-transform|method-visitor|class-visitor|javassist/],
  ['block-registration', /block.*registr|registr.*block/],
  ['item-registration', /item.*registr|registr.*item/],
  [
    'tile-entity-registration',
    /(?:tile-?entity|tileentity).*registr|registr.*(?:tile-?entity|tileentity)/,
  ],
  ['model-registration', /model.*registr|registr.*model/],
  ['event-registration', /event.*registr|registr.*event|event-bus/],
  ['recipe-registration', /recipe.*registr|registr.*recipe/],
  ['entity-registration', /entity.*registr|registr.*entity/],
  ['registry', /registr/],
  ['client-initialization', /client.*(?:init|lifecycle|setup)|(?:init|lifecycle|setup).*client/],
  ['server-initialization', /server.*(?:init|lifecycle|setup)|(?:init|lifecycle|setup).*server/],
  ['proxy-delegation', /proxy/],
  ['lifecycle-hook', /lifecycle|preinit|postinit|init-hook|initialization-hook|init-stub/],
  ['block-construction', /block.*constructor|constructor.*block/],
  ['item-construction', /item.*constructor|constructor.*item/],
  [
    'tile-entity-construction',
    /(?:tile-?entity|tileentity).*constructor|constructor.*(?:tile-?entity|tileentity)/,
  ],
  ['entity-construction', /entity.*constructor|constructor.*entity/],
  ['construction', /constructor|factory|builder/],
  [
    'block-rendering',
    /block.*(?:render|opacity|transparen|full-?cube|shape|aabb|collision|bounding)|(?:render|opacity|shape).*block/,
  ],
  ['model-rendering', /model|baked|quad|texture/],
  ['gui-rendering', /(?:gui|widget).*(?:render|draw)|(?:render|draw).*(?:gui|widget)/],
  ['item-rendering', /item.*(?:render|model|tooltip)|(?:render|model|tooltip).*item/],
  ['entity-rendering', /entity.*render|render.*entity|tesr/],
  ['rendering', /render|texture|color|overlay|drawable/],
  ['block-state', /blockstate|block-state|actual-state|metadata.*state|state.*metadata/],
  [
    'block-shape',
    /block.*(?:shape|aabb|collision|bounding|cube)|(?:shape|aabb|collision|bounding).*block/,
  ],
  ['redstone', /redstone|power/],
  ['block-ticking', /block.*tick|tick.*block|scheduled-update|neighbor-update/],
  [
    'block-interaction',
    /block.*(?:activat|placement|break|drop|rightclick|interaction)|(?:activat|placement|break|drop).*block/,
  ],
  ['block-behavior', /^block-/],
  ['nbt-serialization', /nbt|compound-tag/],
  ['packet-handling', /packet.*handler|handler.*packet|network.*handler/],
  ['network-message', /packet|network|message|channel/],
  ['data-synchronization', /sync|synchron/],
  ['inventory-slot', /slot/],
  ['container', /container/],
  ['inventory-storage', /inventory|itemstack|stack-handler|storage/],
  ['gui-interaction', /gui|widget|screen/],
  [
    'item-interaction',
    /item.*(?:use|action|rightclick|interaction|tooltip)|(?:use|action|rightclick|tooltip).*item/,
  ],
  ['item-behavior', /^item-/],
  ['entity-ai', /entity.*ai|ai-/],
  ['entity-behavior', /entity|mob|spawn/],
  ['event-cancellation', /event.*cancel|cancel.*event/],
  ['event-handler', /event|handler|callback|listener/],
  ['recipe-matching', /recipe|craft/],
  ['world-generation', /worldgen|world-gen|ore-gen|generator/],
  ['biome', /biome/],
  ['dimension', /dimension/],
  ['command', /command/],
  ['configuration', /config/],
  ['particle', /particle/],
  ['sound', /sound/],
  ['animation', /animat/],
  ['fluid', /fluid/],
  ['energy', /energy|rf-/],
  ['resource', /resource/],
  ['compatibility', /compat|integration|optional-mod|cross-platform|jei/],
  ['interface-contract', /interface|contract|api-/],
  ['delegation', /delegat|forward/],
  ['adapter', /adapter/],
  ['wrapper', /wrapper|wrap/],
  ['validation', /validat|guard|check|predicate/],
  ['serialization', /serializ|deserializ|encoding|decoding|json/],
  ['state-management', /state|setter|reset|flag/],
  ['caching', /cache|memoiz|lazy/],
  ['threading', /thread|async|concurr/],
  ['reflection', /reflect/],
  ['logging', /logg/],
  ['collection', /collection|map|list|array/],
  ['utility', /.*/],
];

/** Normalize model leaks before either storing or resolving an alias. */
export function normalizePatternType(pattern: string): string {
  return pattern
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
    .replace(/\bnbtn(?=-|$)/g, 'nbt')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Map one raw model label to the bounded canonical vocabulary. */
export function canonicalizePatternType(pattern: string): CanonicalPattern {
  const alias = normalizePatternType(pattern);
  const canonical =
    CANONICAL_PATTERN_RULES.find(([, match]) => match.test(alias))?.[0] ?? 'utility';
  return { alias, canonical };
}
