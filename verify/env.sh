# verify/env.sh — sourced by every check. Save and `source verify/env.sh` first.
set -euo pipefail

# Project root (the repo whose src/ DESIGN.md cites). Override if not CWD's parent project.
: "${REPO:?set REPO to the project root containing src/index.ts, package.json}"

# The freshly built docs.db (schema v2) produced by `pnpm run index-docs`.
: "${DOCS_DB:?set DOCS_DB to the built docs.db path}"

# Node entry the MCP client subprocess speaks to (implementation-agnostic: real stdio server).
: "${SERVER_CMD:=node ${REPO}/dist/index.js}"

# Authoritative frozen sets (from DESIGN — do not edit to match an impl).
FROM_VOCABS='fabric neoforge modern-minecraft'
TO_LOADERS='cleanroom forge'
KINDS='direct analog pattern-change missing'
ERAS='yarn-<=1.21.11 mojang-26x fabric-pre-1.20.5 legacy-modern-forge-1.16-1.20.1'
TOPICS='registration events networking mixins-access-transformers capabilities-attachments item-block-settings resources-datagen fluids serialization-nbt-codecs resource-loading energy-transfer enchantments advancements permissions particles config data-components block-entity-renderer text-components'
TEMPLATE_COMPONENTS='build.gradle gradle.properties settings.gradle mcmod.info ExampleMod.java mixins.json modid_at.cfg README checklist'
GUIDES='porting-from-fabric porting-from-neoforge backporting mixin-setup'
PROMPTS='scaffold_cleanroom_mod port_mod_to_cleanroom backport_feature'
export REPO DOCS_DB SERVER_CMD FROM_VOCABS TO_LOADERS KINDS ERAS TOPICS TEMPLATE_COMPONENTS GUIDES PROMPTS

pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1"; FAILED=1; }
FAILED=0
