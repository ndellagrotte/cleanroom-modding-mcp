<div align="center">

# Cleanroom Modding MCP

### 🤖 An MCP server for building Cleanroom (Minecraft 1.12.2) mods with AI agents

_Docs, SRG mappings, and cross-loader porting knowledge for the Cleanroom / Forge 1.12.2 ecosystem_

[![License: GPL-V3](https://img.shields.io/badge/License-GPLV3-green?style=flat-square)](https://opensource.org/license/gpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-≥20.0.0-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)

</div>

## What is this?

**cleanroom-modding-mcp** is a [Model Context Protocol](https://modelcontextprotocol.io/) server whose mission is making an AI agent as effective as a veteran 1.12.2 modder. It serves three workflows, in priority order:

1. **From-scratch [Cleanroom](https://github.com/CleanroomMC/Cleanroom) mod development** — Cleanroom is the continuation of the Forge modloader for Minecraft 1.12.2, running on Java 25+ with built-in mixin support.
2. **Cross-loader ports to Cleanroom** — the Fabric and NeoForge corpora are retained as *porting reference*: searchable source-loader documentation for translating mods to 1.12.2.
3. **Backports to Cleanroom** — modern-Minecraft knowledge (docs, Parchment/Mojang mappings) serves as the source side of a backport.

> **Status:** this project is a reoriented fork of [`OGMatrix/mcmodding-mcp`](https://github.com/OGMatrix/mcmodding-mcp), being transformed per [DESIGN.md](DESIGN.md). The distribution layer and identity are done; the Cleanroom-specific corpora and tools land phase by phase.

## Quick Start

### Installation

```bash
# Install
npm i @ndellagrotte/cleanroom-modding-mcp
```

Add to your MCP client configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cleanroom": {
      "command": "cleanroom-modding-mcp"
    }
  }
}
```

### Claude Code

For [Claude Code](https://docs.anthropic.com/en/docs/claude-code), add this server via a project-scoped `.mcp.json` file at the repository root. This is an example `.mcp.json` config for Linux:

```json
{
  "mcpServers": {
    "cleanroom": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/home/ndellagrotte/IdeaProjects/mcmodding-mcp/dist/index.js"
      ],
      "env": {
        "CLEANROOM_MCP_DATA_DIR": "/home/ndellagrotte/IdeaProjects/mcmodding-mcp/data",
        "CLEANROOM_MCP_SKIP_AUTO_UPDATE": "1"
      }
    }
  }
}
```

(Adjust the absolute paths to your local checkout.)

## Databases

All database assets are attached to this repository's `v{version}` GitHub Releases and verified by SHA256 manifest.

| Database | File | Installed | Auto-update |
| --- | --- | --- | --- |
| 📚 Documentation | `docs.db` | automatically (postinstall / first use) | on every startup |
| 🗺️ Mappings | `mappings.db` | via `manage` (prebuilt download, or local 1.12.2 build) | once installed¹ |
| 🧩 Mod examples | `examples.db` | via `manage` | once installed |
| 🧬 Cleanroom API | `cleanroom-api.db` | via `manage` | once installed |

¹ The mappings database can also be **built on-device** — `cleanroom-modding-mcp manage --build-mappings` fetches the MCP sources (~730 KB from `maven.outlands.top` / `maven.minecraftforge.net`) and builds the 1.12.2 MCP/SRG data locally in under a minute (no modern reference versions). Locally built databases are never overwritten by auto-update; switch back to the prebuilt DB explicitly via `manage`.

Databases live in a shared platform-standard data directory:

- Linux: `$XDG_DATA_HOME/cleanroom-modding-mcp` (default `~/.local/share/cleanroom-modding-mcp`)
- macOS: `~/Library/Application Support/cleanroom-modding-mcp`
- Windows: `%APPDATA%/cleanroom-modding-mcp`

## Tools

Four base tools are always available; the mappings, mod-examples, and Cleanroom API tool groups register automatically when their optional databases are installed (the table below groups them by database, not by registration order).

| Tool | Purpose |
| --- | --- |
| `search_docs` | Hybrid full-text + semantic search. Scope `target` (Cleanroom/Forge 1.12.2, default), `reference` (Fabric/NeoForge porting material), or `all` |
| `get_example` | Code examples for modding topics, filterable by scope/loader/version |
| `explain_concept` | Concept explanations from a loader's perspective (default: Cleanroom) — capabilities, SRG names, mixins, `mcmod.info`, … |
| `list_targets` | Orientation: the loader/version matrix, indexed versions, installed databases |
| `resolve_symbol` | Crash-log workhorse: resolve any symbol (SRG `func_/field_/p_`, obfuscated notch tokens, readable names) to all mapping layers (requires `mappings.db`) |
| `search_mappings`, `get_class_details`, `get_method_signature`, `list_mapping_versions`, `browse_package` | Minecraft class/method/field mappings — 1.12.2 MCP/SRG (default) + modern Parchment/Mojang backport reference (requires `mappings.db`) |
| `search_cleanroom_api`, `get_api_class` | Cleanroom/Forge framework API surface (`com.cleanroommc.*`, `zone.rong.mixinbooter.*`, `net.minecraftforge.*`): classes, events catalog, annotations catalog, signatures + Javadoc from the pinned Cleanroom sources (requires `cleanroom-api.db`) |
| `search_mod_examples`, `get_mod_example`, `list_canonical_mods`, `list_mod_categories`, `get_mod_patterns` | Curated mod examples (requires `examples.db`) |

## Environment Variables

| Variable | Effect |
| --- | --- |
| `CLEANROOM_MCP_DATA_DIR` | Override the shared data directory |
| `CLEANROOM_MCP_SKIP_AUTO_UPDATE` | Skip the startup database update check |
| `DB_PATH` | Explicit path to the docs database file (does **not** disable auto-update, which targets the default path) |
| `GITHUB_REPO_URL` | Override the GitHub API repo base used for release lookups |
| `GITHUB_TOKEN` | Used by postinstall for authenticated GitHub API requests (rate limits) |

## Development

```bash
pnpm install          # install dependencies
pnpm run build        # compile to dist/
pnpm test             # vitest
pnpm run validate     # typecheck + lint + test

pnpm run index-docs         # crawl + index the documentation corpus into data/docs.db
pnpm run index-mappings     # build data/mappings.db
pnpm run manifest -- --db docs --release-tag v0.5.0   # generate a release manifest
```

### Distribution convention

Every database and its `<id>-manifest.json` are uploaded to the main `v{version}` release — there are no per-database release tags. The manifest generator (`scripts/generate-manifest.ts`), the installer (`manage`), postinstall, and the startup auto-updater all read the single registry in [`src/dbs.ts`](src/dbs.ts); no other file may hardcode a database filename or the repository slug.

## Credits & License

GPL-V3. Forked from [OGMatrix/mcmodding-mcp](https://github.com/OGMatrix/mcmodding-mcp); reoriented for the [CleanroomMC](https://github.com/CleanroomMC) ecosystem (not affiliated with CleanroomMC).
