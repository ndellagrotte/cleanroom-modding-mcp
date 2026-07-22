/**
 * Platform-appropriate shared data directory for cleanroom-modding-mcp.
 *
 * Instead of storing databases relative to `process.cwd()` (which changes per
 * project and per MCP client), we use a single, shared, platform-standard
 * location so that:
 *   - `cleanroom-modding-mcp manage` and the MCP server always read/write the same DB
 *   - Databases are downloaded once and shared across all projects
 *   - No need to .gitignore anything in project directories
 *
 * Override order:
 *   1. Explicit `dbPath` argument (always wins)
 *   2. `CLEANROOM_MCP_DATA_DIR` environment variable
 *   3. Platform default (XDG on Linux, Application Support on macOS, APPDATA on Windows)
 */

import os from 'os';
import path from 'path';

const DIR_NAME = 'cleanroom-modding-mcp';

/**
 * Get the default platform-appropriate shared data directory.
 *
 * - Linux:   $XDG_DATA_HOME/cleanroom-modding-mcp  (default ~/.local/share/cleanroom-modding-mcp)
 * - macOS:   ~/Library/Application Support/cleanroom-modding-mcp
 * - Windows: %APPDATA%/cleanroom-modding-mcp
 */
export function getDefaultDataDir(): string {
  // Allow full override via environment variable
  if (process.env.CLEANROOM_MCP_DATA_DIR) {
    return process.env.CLEANROOM_MCP_DATA_DIR;
  }

  const platform = process.platform;

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, DIR_NAME);
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', DIR_NAME);
  }

  // Linux / FreeBSD / others: follow XDG Base Directory Specification
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, DIR_NAME);
}

/**
 * Get the default path for a specific database file inside the shared data directory.
 */
export function getDefaultDbPath(fileName: string): string {
  return path.join(getDefaultDataDir(), fileName);
}
