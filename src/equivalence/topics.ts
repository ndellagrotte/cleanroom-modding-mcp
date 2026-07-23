/**
 * Canonical equivalence topic vocabulary (DESIGN §3.2).
 *
 * This is the authoritative list `find_equivalent(topic?)` validates against and the
 * porting prompts enumerate. It is deliberately DECOUPLED from KNOWN_CONCEPTS — the
 * corpus taxonomy is broader than what explain_concept answers.
 */
export const TOPIC_VALUES = [
  'registration',
  'events',
  'networking',
  'mixins-access-transformers',
  'capabilities-attachments',
  'item-block-settings',
  'resources-datagen',
  'fluids',
  'serialization-nbt-codecs',
  'resource-loading',
  'energy-transfer',
  'enchantments',
  'advancements',
  'permissions',
  'particles',
  'config',
  'data-components',
  'block-entity-renderer',
  'text-components',
] as const;

export type Topic = (typeof TOPIC_VALUES)[number];

/** Runtime membership set mirroring TOPIC_VALUES. */
export const TOPIC_SET: ReadonlySet<string> = new Set(TOPIC_VALUES);
