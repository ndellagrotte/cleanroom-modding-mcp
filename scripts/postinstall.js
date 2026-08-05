#!/usr/bin/env node
/* eslint-disable no-undef, no-control-regex, no-unused-vars */

/**
 * cleanroom-modding-mcp postinstall script
 * Downloads every database in the registry during npm installation.
 *
 * All identity facts (repo slug, DB/manifest filenames, data directory) come
 * from the compiled registry in dist/ — this script must never duplicate them.
 * In a dev checkout without dist/, the download is skipped: the server fetches
 * the databases on first use.
 *
 * The databases are independent: one failing (missing release asset, bad hash,
 * network error) must never abort the others, and nothing here may fail the
 * npm install — the startup auto-updater retries whatever is still missing.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import Database from 'better-sqlite3';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION (from the compiled dist/ registry — published tarballs always ship dist/)
// ═══════════════════════════════════════════════════════════════════════════════

let CONFIG;
try {
  const { getDefaultDataDir } = await import('../dist/data-dir.js');
  const { DBS, DB_IDS, getApiBase, REPO_URL, USER_AGENT, PACKAGE_NAME, selectRelease } =
    await import('../dist/dbs.js');
  CONFIG = {
    releasesUrl: `${getApiBase()}/releases`,
    dataDir: getDefaultDataDir(),
    userAgent: USER_AGENT,
    repoUrl: REPO_URL,
    packageName: PACKAGE_NAME,
    // Registry order: the docs DB the base tools need comes first.
    specs: DB_IDS.map((id) => DBS[id]),
    selectRelease,
  };
} catch {
  console.log('cleanroom-modding-mcp: dist/ not built — skipping database download.');
  console.log('The databases will be downloaded on first use.');
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANSI COLORS & STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const isColorSupported = process.stdout.isTTY && !process.env.NO_COLOR;

const c = {
  // Reset
  reset: isColorSupported ? '\x1b[0m' : '',
  // Styles
  bold: isColorSupported ? '\x1b[1m' : '',
  dim: isColorSupported ? '\x1b[2m' : '',
  italic: isColorSupported ? '\x1b[3m' : '',
  underline: isColorSupported ? '\x1b[4m' : '',
  // Colors
  black: isColorSupported ? '\x1b[30m' : '',
  red: isColorSupported ? '\x1b[31m' : '',
  green: isColorSupported ? '\x1b[32m' : '',
  yellow: isColorSupported ? '\x1b[33m' : '',
  blue: isColorSupported ? '\x1b[34m' : '',
  magenta: isColorSupported ? '\x1b[35m' : '',
  cyan: isColorSupported ? '\x1b[36m' : '',
  white: isColorSupported ? '\x1b[37m' : '',
  // Bright colors
  brightBlack: isColorSupported ? '\x1b[90m' : '',
  brightRed: isColorSupported ? '\x1b[91m' : '',
  brightGreen: isColorSupported ? '\x1b[92m' : '',
  brightYellow: isColorSupported ? '\x1b[93m' : '',
  brightBlue: isColorSupported ? '\x1b[94m' : '',
  brightMagenta: isColorSupported ? '\x1b[95m' : '',
  brightCyan: isColorSupported ? '\x1b[96m' : '',
  brightWhite: isColorSupported ? '\x1b[97m' : '',
  // Backgrounds
  bgBlack: isColorSupported ? '\x1b[40m' : '',
  bgRed: isColorSupported ? '\x1b[41m' : '',
  bgGreen: isColorSupported ? '\x1b[42m' : '',
  bgYellow: isColorSupported ? '\x1b[43m' : '',
  bgBlue: isColorSupported ? '\x1b[44m' : '',
  bgMagenta: isColorSupported ? '\x1b[45m' : '',
  bgCyan: isColorSupported ? '\x1b[46m' : '',
  bgWhite: isColorSupported ? '\x1b[47m' : '',
  // Cursor
  clearLine: isColorSupported ? '\x1b[2K' : '',
  cursorUp: isColorSupported ? '\x1b[1A' : '',
  cursorHide: isColorSupported ? '\x1b[?25l' : '',
  cursorShow: isColorSupported ? '\x1b[?25h' : '',
};

// ═══════════════════════════════════════════════════════════════════════════════
// UNICODE SYMBOLS & BOX DRAWING
// ═══════════════════════════════════════════════════════════════════════════════

const sym = {
  // Box drawing (double line)
  topLeft: '╔',
  topRight: '╗',
  bottomLeft: '╚',
  bottomRight: '╝',
  horizontal: '═',
  vertical: '║',
  // Box drawing (single line)
  sTopLeft: '┌',
  sTopRight: '┐',
  sBottomLeft: '└',
  sBottomRight: '┘',
  sHorizontal: '─',
  sVertical: '│',
  // Progress bar
  barFull: '█',
  barThreeQuarter: '▓',
  barHalf: '▒',
  barQuarter: '░',
  barEmpty: '░',
  // Status symbols
  check: '✔',
  cross: '✖',
  warning: '⚠',
  info: 'ℹ',
  star: '★',
  sparkle: '✨',
  rocket: '🚀',
  package: '📦',
  database: '🗄️',
  download: '⬇',
  shield: '🛡️',
  clock: '⏱',
  lightning: '⚡',
  cube: '◆',
  arrow: '→',
  arrowRight: '▶',
  dot: '●',
  circle: '○',
  diamond: '◇',
  // Minecraft themed
  pickaxe: '⛏',
  gear: '⚙',
  book: '📖',
};

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function getTerminalWidth() {
  return process.stdout.columns || 80;
}

function centerText(text, width) {
  const cleanText = text.replace(/\x1b\[[0-9;]*m/g, '');
  const totalPadding = Math.max(0, width - cleanText.length);
  const leftPadding = Math.floor(totalPadding / 2);
  const rightPadding = totalPadding - leftPadding;
  return ' '.repeat(leftPadding) + text + ' '.repeat(rightPadding);
}

function padRight(text, width) {
  const cleanText = text.replace(/\x1b\[[0-9;]*m/g, '');
  const padding = Math.max(0, width - cleanText.length);
  return text + ' '.repeat(padding);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond) {
  return formatBytes(bytesPerSecond) + '/s';
}

function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// VISUAL COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  const width = Math.min(getTerminalWidth(), 72);
  const innerWidth = width - 2;

  console.log();
  console.log(
    c.brightCyan + sym.topLeft + sym.horizontal.repeat(width - 2) + sym.topRight + c.reset
  );

  // Logo
  const logo = [
    ``,
    `${c.brightGreen}${c.bold}CLEANROOM MODDING MCP${c.reset}`,
    ``,
  ];

  logo.forEach((line) => {
    console.log(
      c.brightCyan +
        sym.vertical +
        c.reset +
        centerText(line, innerWidth) +
        c.brightCyan +
        sym.vertical +
        c.reset
    );
  });

  // Subtitle
  const subtitle = `${c.brightMagenta}${sym.pickaxe} ${c.bold}Minecraft 1.12.2 Modding Knowledge${c.reset}${c.brightMagenta} ${sym.pickaxe}${c.reset}`;
  console.log(
    c.brightCyan +
      sym.vertical +
      c.reset +
      centerText(subtitle, innerWidth) +
      c.brightCyan +
      sym.vertical +
      c.reset
  );

  const subtitle2 = `${c.dim}Model Context Protocol Server${c.reset}`;
  console.log(
    c.brightCyan +
      sym.vertical +
      c.reset +
      centerText(subtitle2, innerWidth) +
      c.brightCyan +
      sym.vertical +
      c.reset
  );

  console.log(
    c.brightCyan + sym.bottomLeft + sym.horizontal.repeat(width - 2) + sym.bottomRight + c.reset
  );
  console.log();
}

function printSectionHeader(title, icon = sym.arrowRight) {
  const width = Math.min(getTerminalWidth(), 72);
  console.log();
  console.log(
    c.brightBlue +
      sym.sTopLeft +
      sym.sHorizontal.repeat(2) +
      c.reset +
      ` ${c.bold}${icon} ${title}${c.reset} ` +
      c.brightBlue +
      sym.sHorizontal.repeat(Math.max(0, width - title.length - 10)) +
      sym.sTopRight +
      c.reset
  );
}

function printSectionFooter() {
  const width = Math.min(getTerminalWidth(), 72);
  console.log(
    c.brightBlue + sym.sBottomLeft + sym.sHorizontal.repeat(width - 2) + sym.sBottomRight + c.reset
  );
}

function createProgressBar(progress, width = 40, showGradient = true) {
  const clampedProgress = Math.min(Math.max(progress, 0), 1);
  const filled = Math.round(clampedProgress * width);
  const empty = Math.max(0, width - filled);

  let bar = '';
  if (showGradient && isColorSupported) {
    // Gradient effect from green to cyan
    for (let i = 0; i < filled; i++) {
      const ratio = i / width;
      if (ratio < 0.33) bar += c.green + sym.barFull;
      else if (ratio < 0.66) bar += c.brightGreen + sym.barFull;
      else bar += c.brightCyan + sym.barFull;
    }
    bar += c.reset;
  } else {
    bar = c.brightGreen + sym.barFull.repeat(filled) + c.reset;
  }

  bar += c.dim + sym.barEmpty.repeat(empty) + c.reset;
  return bar;
}

class ProgressDisplay {
  constructor(label = 'database') {
    this.label = label;
    this.lines = 0;
    this.startTime = Date.now();
    this.lastUpdate = 0;
    this.speeds = [];
    this.lastMilestone = -1;
  }

  clear() {
    if (isColorSupported && this.lines > 0) {
      // Move cursor up and clear all lines in a single write operation
      const clearSequence = (c.cursorUp + c.clearLine).repeat(this.lines);
      process.stdout.write(clearSequence);
    }
    this.lines = 0;
  }

  calculateSpeed(downloaded, elapsed) {
    if (elapsed === 0) return 0;
    const currentSpeed = downloaded / elapsed;
    this.speeds.push(currentSpeed);
    if (this.speeds.length > 5) this.speeds.shift();
    return this.speeds.reduce((a, b) => a + b, 0) / this.speeds.length;
  }

  update(downloaded, total, phase = 'download') {
    const now = Date.now();
    if (now - this.lastUpdate < 100) return; // Throttle updates
    this.lastUpdate = now;

    const progressRatio = total > 0 ? downloaded / total : 0;
    const percent = Math.round(progressRatio * 100);

    // Piped stdout (the npm log): the cursor codes are empty strings, so a
    // rewrite becomes an append. Emit one line per quarter instead of the
    // ~1800 stale frames a large download would otherwise leave in the log.
    if (!isColorSupported) {
      const milestone = Math.floor(percent / 25);
      if (phase !== 'download' || milestone <= this.lastMilestone) return;
      this.lastMilestone = milestone;
      console.log(
        `  ${this.label}: ${percent}% (${formatBytes(downloaded)} / ${formatBytes(total)})`
      );
      return;
    }

    this.clear();

    const width = Math.min(getTerminalWidth(), 72);
    const barWidth = Math.max(20, width - 35);
    const progress = progressRatio;
    const elapsed = (now - this.startTime) / 1000;
    const speed = this.calculateSpeed(downloaded, elapsed);
    const eta = speed > 0 ? (total - downloaded) / speed : 0;

    const lines = [];

    // Status line with icon
    const statusIcon = phase === 'download' ? sym.download : sym.shield;
    const statusText =
      phase === 'download' ? `Downloading ${this.label}...` : `Verifying ${this.label}...`;
    lines.push(`  ${c.brightYellow}${statusIcon}${c.reset} ${c.bold}${statusText}${c.reset}`);

    // Progress bar
    const bar = createProgressBar(progress, barWidth);
    const percentStr = `${percent}%`.padStart(4);
    lines.push(
      `  ${c.dim}[${c.reset}${bar}${c.dim}]${c.reset} ${c.brightWhite}${percentStr}${c.reset}`
    );

    // Stats line
    const downloadedStr = formatBytes(downloaded);
    const totalStr = formatBytes(total);
    const speedStr = phase === 'download' ? formatSpeed(speed) : '';
    const etaStr = phase === 'download' && eta > 0 ? `ETA: ${formatTime(eta)}` : '';

    let statsLine = `  ${c.dim}${sym.cube}${c.reset} ${c.cyan}${downloadedStr}${c.reset} ${c.dim}/${c.reset} ${c.cyan}${totalStr}${c.reset}`;
    if (speedStr)
      statsLine += `  ${c.dim}${sym.lightning}${c.reset} ${c.brightMagenta}${speedStr}${c.reset}`;
    if (etaStr) statsLine += `  ${c.dim}${sym.clock}${c.reset} ${c.yellow}${etaStr}${c.reset}`;

    lines.push(statsLine);

    // Print all lines as a single write operation to prevent flickering
    this.lines = lines.length;
    process.stdout.write(lines.join('\n') + '\n');
  }

}

/**
 * Owns exactly one terminal line, for one database. On a TTY the line is
 * rewritten in place as that database progresses; when stdout is a pipe the
 * cursor codes are empty strings, so transient states are dropped instead and
 * only the final one is appended. This and ProgressDisplay.clear() are the only
 * places in this file that move the cursor.
 */
class DbLine {
  constructor(index, total, spec) {
    this.label = `[${index}/${total}]`;
    this.spec = spec;
    this.printed = false;
  }

  set(status, detail = '') {
    if (status === 'active' && !isColorSupported) return;

    const icons = {
      active: c.brightYellow + sym.dot + c.reset,
      done: c.brightGreen + sym.check + c.reset,
      skip: c.brightBlack + sym.circle + c.reset,
      error: c.brightRed + sym.cross + c.reset,
    };
    const colors = { active: c.brightWhite, done: c.green, skip: c.dim, error: c.red };

    if (this.printed && isColorSupported) {
      process.stdout.write(c.cursorUp + c.clearLine);
    }
    const name = padRight(`${this.spec.icon} ${this.spec.name}`, 32);
    console.log(
      `  ${icons[status]} ${c.dim}${this.label}${c.reset} ${colors[status]}${name}${c.reset} ${detail}`
    );
    this.printed = true;
  }
}

function printWelcomeScreen(results = []) {
  const width = Math.min(getTerminalWidth(), 72);
  const innerWidth = width - 4;
  const docsAvailable = results.some((r) => r.spec.required && r.status !== 'failed');

  console.log();
  console.log(
    c.brightGreen +
      '  ' +
      sym.sparkle +
      (docsAvailable
        ? ' Installation Complete! '
        : ' Server Installed — Database Unavailable ') +
      sym.sparkle +
      c.reset
  );
  console.log();

  // Welcome box
  console.log(
    c.green + '  ' + sym.topLeft + sym.horizontal.repeat(width - 4) + sym.topRight + c.reset
  );

  const welcomeLines = [
    '',
    `${c.bold}${c.brightWhite}${docsAvailable ? 'Welcome to Cleanroom Modding MCP!' : 'Documentation database was not installed'}${c.reset}`,
    '',
    ...(docsAvailable
      ? [
          `${c.dim}Your AI assistant now has access to Minecraft${c.reset}`,
          `${c.dim}modding knowledge for:${c.reset}`,
        ]
      : [
          `${c.dim}The server will retry on startup. Data-backed tools${c.reset}`,
          `${c.dim}remain unavailable until a release database downloads.${c.reset}`,
        ]),
    '',
    `  ${c.brightGreen}${sym.check}${c.reset} ${c.cyan}Cleanroom / Forge 1.12.2${c.reset} - the development target`,
    `  ${c.brightGreen}${sym.check}${c.reset} ${c.magenta}Fabric & NeoForge${c.reset} - porting reference`,
    '',
  ];

  welcomeLines.forEach((line) => {
    const paddedLine = centerText(line, innerWidth);
    console.log(
      c.green + '  ' + sym.vertical + c.reset + paddedLine + c.green + sym.vertical + c.reset
    );
  });

  console.log(
    c.green + '  ' + sym.bottomLeft + sym.horizontal.repeat(width - 4) + sym.bottomRight + c.reset
  );
  console.log();

  // Quick start section
  console.log(
    c.brightBlue +
      '  ' +
      sym.sTopLeft +
      sym.sHorizontal.repeat(2) +
      c.reset +
      ` ${c.bold}${sym.rocket} Quick Start${c.reset} ` +
      c.brightBlue +
      sym.sHorizontal.repeat(width - 20) +
      sym.sTopRight +
      c.reset
  );
  console.log(c.brightBlue + '  ' + sym.sVertical + c.reset);

  const quickStart = [
    [`${c.yellow}Configure Claude Desktop:${c.reset}`, ''],
    [
      `${c.dim}Add to your ${c.reset}${c.cyan}claude_desktop_config.json${c.reset}${c.dim}:${c.reset}`,
      '',
    ],
    ['', ''],
    [`  ${c.brightBlack}{${c.reset}`, ''],
    [`    ${c.brightBlue}"mcpServers"${c.reset}: {`, ''],
    [`      ${c.brightGreen}"cleanroom"${c.reset}: {`, ''],
    [`        ${c.brightMagenta}"command"${c.reset}: ${c.yellow}"npx"${c.reset},`, ''],
    [`        ${c.brightMagenta}"args"${c.reset}: [${c.yellow}"cleanroom-modding-mcp"${c.reset}]`, ''],
    [`      }`, ''],
    [`    }`, ''],
    [`  ${c.brightBlack}}${c.reset}`, ''],
  ];

  quickStart.forEach(([line]) => {
    console.log(c.brightBlue + '  ' + sym.sVertical + c.reset + '  ' + line);
  });

  console.log(c.brightBlue + '  ' + sym.sVertical + c.reset);
  console.log(
    c.brightBlue +
      '  ' +
      sym.sBottomLeft +
      sym.sHorizontal.repeat(width - 4) +
      sym.sBottomRight +
      c.reset
  );
  console.log();

  // Available tools section
  console.log(
    c.brightMagenta +
      '  ' +
      sym.sTopLeft +
      sym.sHorizontal.repeat(2) +
      c.reset +
      ` ${c.bold}${sym.gear} Available Tools${c.reset} ` +
      c.brightMagenta +
      sym.sHorizontal.repeat(width - 24) +
      sym.sTopRight +
      c.reset
  );
  console.log(c.brightMagenta + '  ' + sym.sVertical + c.reset);

  // The base tools are always registered; the rest appear only when their
  // database landed, so they are listed off the actual install results.
  const toolsByDb = {
    mappings: [
      [`${c.brightCyan}resolve_symbol${c.reset}`, 'Resolve SRG/obfuscated names from crash logs'],
      [`${c.brightCyan}search_mappings${c.reset}`, 'Minecraft class/method/field mappings'],
    ],
    'cleanroom-api': [
      [`${c.brightCyan}search_cleanroom_api${c.reset}`, 'Cleanroom/Forge framework API surface'],
    ],
    examples: [
      [`${c.brightCyan}search_mod_examples${c.reset}`, 'Curated code from real 1.12.2 mods'],
    ],
  };

  const tools = [
    [`${c.brightCyan}search_docs${c.reset}`, 'Search modding docs (Cleanroom/Forge 1.12.2 first)'],
    [`${c.brightCyan}get_doc_snippet${c.reset}`, 'Code snippets from the scraped modding docs'],
    [`${c.brightCyan}explain_concept${c.reset}`, 'Explain modding concepts and patterns'],
    [`${c.brightCyan}list_targets${c.reset}`, 'Show target/reference loaders and installed DBs'],
    ...results
      .filter((r) => r.status !== 'failed')
      .flatMap((r) => toolsByDb[r.spec.id] ?? []),
  ];

  tools.forEach(([name, desc]) => {
    console.log(c.brightMagenta + '  ' + sym.sVertical + c.reset + `  ${sym.arrowRight} ${name}`);
    console.log(c.brightMagenta + '  ' + sym.sVertical + c.reset + `    ${c.dim}${desc}${c.reset}`);
  });

  console.log(c.brightMagenta + '  ' + sym.sVertical + c.reset);
  console.log(
    c.brightMagenta +
      '  ' +
      sym.sBottomLeft +
      sym.sHorizontal.repeat(width - 4) +
      sym.sBottomRight +
      c.reset
  );
  console.log();

  // Footer links
  console.log(c.dim + '  ' + sym.sHorizontal.repeat(width - 4) + c.reset);
  console.log();
  console.log(
    `  ${c.dim}${sym.book}${c.reset} ${c.brightBlue}GitHub:${c.reset} ${c.underline}${CONFIG.repoUrl}${c.reset}`
  );
  console.log(
    `  ${c.dim}${sym.warning}${c.reset} ${c.brightBlue}Issues:${c.reset} ${c.underline}${CONFIG.repoUrl}/issues${c.reset}`
  );
  console.log();
  console.log(c.dim + '  ' + sym.sHorizontal.repeat(width - 4) + c.reset);
  console.log();
  console.log(
    `  ${c.brightGreen}${sym.sparkle}${c.reset} ${c.italic}Happy modding!${c.reset} ${c.brightGreen}${sym.sparkle}${c.reset}`
  );
  console.log();
}

// ═══════════════════════════════════════════════════════════════════════════════
// NETWORK FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': CONFIG.userAgent,
      Accept: 'application/vnd.github.v3+json',
      ...options.headers,
    };

    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const req = https.get(
      url,
      {
        headers,
      },
      (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGet(res.headers.location, options).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        if (options.stream) {
          resolve(res);
          return;
        }

        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function downloadWithProgress(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const makeRequest = (requestUrl) => {
      const urlObj = new URL(requestUrl);
      const headers = {
        'User-Agent': CONFIG.userAgent,
      };

      if (process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }

      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        headers,
      };

      https
        .get(options, (res) => {
          // Handle redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            makeRequest(res.headers.location);
            return;
          }

          if (res.statusCode !== 200) {
            file.close();
            fs.unlinkSync(destPath);
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const total = parseInt(res.headers['content-length'], 10) || 0;
          let downloaded = 0;

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            // Honour backpressure: without this a slow disk buffers the whole
            // database (hundreds of MB) in memory.
            if (!file.write(chunk)) {
              res.pause();
              file.once('drain', () => res.resume());
            }
            if (onProgress) onProgress(downloaded, total);
          });

          res.on('end', () => {
            // Resolve only once the write stream has flushed — the hash check
            // reads this file back immediately and would otherwise hash a
            // short file and report a bogus mismatch.
            file.end(() => resolve({ downloaded, total }));
          });

          res.on('error', (err) => {
            file.close();
            fs.unlinkSync(destPath);
            reject(err);
          });
        })
        .on('error', (err) => {
          file.close();
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          reject(err);
        });
    };

    makeRequest(url);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN INSTALLATION LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The one GitHub API call this script makes. Every database resolves against
 * this single list — `selectRelease` is pure — so installing four databases
 * costs the same 1/60 of the unauthenticated hourly budget as installing one.
 */
async function fetchReleases() {
  return JSON.parse(await httpsGet(CONFIG.releasesUrl));
}

/** Newest release carrying this DB's file + manifest pair. Throws if there is none. */
function resolveDbRelease(releases, spec) {
  const selected = CONFIG.selectRelease(releases, spec, { requireManifest: true });
  if (!selected) {
    throw new Error(`no release carries ${spec.fileName} + ${spec.manifestName}`);
  }
  return selected;
}

async function fetchManifest(manifestUrl) {
  const response = await httpsGet(manifestUrl);
  return JSON.parse(response);
}

async function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function verifyWithProgress(filePath, expectedHash, progress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stats = fs.statSync(filePath);
    const total = stats.size;
    let processed = 0;

    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => {
      hash.update(chunk);
      processed += chunk.length;
      progress.update(processed, total, 'verify');
    });

    stream.on('end', () => {
      const actualHash = hash.digest('hex');
      resolve(actualHash === expectedHash);
    });

    stream.on('error', reject);
  });
}

function readSchemaVersion(filePath) {
  try {
    const db = new Database(filePath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
        .get();
      const version = Number.parseInt(row?.value, 10);
      return Number.isNaN(version) ? null : version;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Temp file of the download in flight, so an interrupt doesn't orphan it. */
let activeTempPath = null;

/**
 * Download, verify, and install one database. Never throws and never touches
 * another database's state: a failure here is reported and the loop moves on,
 * because the startup auto-updater retries whatever is still missing.
 */
async function installDb(entry, index, total) {
  const { spec, present, resolved, reason } = entry;
  const line = new DbLine(index, total, spec);
  const base = { id: spec.id, name: spec.name, spec };

  if (present) {
    line.set('skip', `${c.dim}already installed${c.reset}`);
    return { ...base, status: 'present' };
  }
  if (!resolved) {
    line.set('error', `${c.dim}${reason}${c.reset}`);
    return { ...base, status: 'failed', reason };
  }

  const dbPath = path.join(CONFIG.dataDir, spec.fileName);
  const manifestPath = path.join(CONFIG.dataDir, spec.manifestName);
  const tempPath = dbPath + '.tmp';
  const downloadProgress = new ProgressDisplay(spec.name);
  const verifyProgress = new ProgressDisplay(spec.name);

  try {
    line.set('active', `${c.dim}fetching manifest...${c.reset}`);
    const manifest = await fetchManifest(resolved.manifestAsset.browser_download_url);
    if (manifest.schemaVersion !== spec.schemaVersion) {
      throw new Error(
        `release manifest schema v${manifest.schemaVersion ?? 'missing'} does not match required v${spec.schemaVersion}`
      );
    }
    // The release asset is authoritative; the URL baked into the manifest may be stale.
    manifest.downloadUrl = resolved.dbAsset.browser_download_url;

    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    // A previous interrupted run can leave hundreds of MB behind here.
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    activeTempPath = tempPath;

    line.set('active', `${c.dim}downloading ${formatBytes(manifest.size)}...${c.reset}`);
    await downloadWithProgress(manifest.downloadUrl, tempPath, (downloaded, downloadTotal) => {
      downloadProgress.update(downloaded, downloadTotal || manifest.size, 'download');
    });
    downloadProgress.clear();

    line.set('active', `${c.dim}verifying...${c.reset}`);
    if (!(await verifyWithProgress(tempPath, manifest.hash, verifyProgress))) {
      throw new Error('hash verification failed');
    }
    verifyProgress.clear();

    const downloadedSchema = readSchemaVersion(tempPath);
    if (downloadedSchema !== spec.schemaVersion) {
      throw new Error(
        `downloaded database schema v${downloadedSchema ?? 'unreadable'} does not match required v${spec.schemaVersion}`
      );
    }

    fs.renameSync(tempPath, dbPath);
    activeTempPath = null;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    line.set('done', `${c.brightCyan}v${manifest.version}${c.reset} ${c.dim}${formatBytes(manifest.size)}${c.reset}`);
    return { ...base, status: 'installed', version: manifest.version, size: manifest.size };
  } catch (error) {
    line.set('error', `${c.dim}${error.message}${c.reset}`);
    return { ...base, status: 'failed', reason: error.message };
  } finally {
    // Idempotent: guarantees the progress blocks own no lines past this point.
    downloadProgress.clear();
    verifyProgress.clear();
    // The temp file itself, plus the -shm/-wal sidecars the schema check makes
    // when it opens it — those are named after the temp path, so the rename to
    // the final name would strand them in the data directory.
    for (const stray of [tempPath, `${tempPath}-shm`, `${tempPath}-wal`]) {
      if (fs.existsSync(stray)) {
        try {
          fs.unlinkSync(stray);
        } catch {
          /* best effort */
        }
      }
    }
    activeTempPath = null;
  }
}

function printSummary(results) {
  const installed = results.filter((r) => r.status === 'installed');
  const present = results.filter((r) => r.status === 'present');
  const failed = results.filter((r) => r.status === 'failed');

  const icon = failed.length
    ? c.brightYellow + sym.warning
    : c.brightGreen + sym.check;
  console.log();
  console.log(
    `  ${icon}${c.reset} ${c.white}${installed.length} installed${c.reset} ${c.dim}·${c.reset} ` +
      `${c.white}${present.length} already present${c.reset} ${c.dim}·${c.reset} ` +
      `${failed.length ? c.brightRed : c.white}${failed.length} failed${c.reset}`
  );
  for (const item of failed) {
    console.log(
      `    ${c.brightYellow}${sym.warning}${c.reset} ${c.dim}${item.name} — the server retries this on startup.${c.reset}`
    );
  }
}

async function main() {
  // Hide cursor during installation
  if (isColorSupported) process.stdout.write(c.cursorHide);

  // Ensure cursor is shown, and no partial download is left behind, on exit
  const cleanup = () => {
    if (isColorSupported) process.stdout.write(c.cursorShow);
    if (activeTempPath && fs.existsSync(activeTempPath)) {
      try {
        fs.unlinkSync(activeTempPath);
      } catch {
        /* best effort */
      }
      activeTempPath = null;
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0); // An interrupted download must not fail the npm install
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  let results = [];
  try {
    printBanner();

    printSectionHeader('Installing Databases', sym.package);
    console.log();

    // One API call covers every database — selectRelease is pure.
    let releases;
    try {
      await sleep(300);
      releases = await fetchReleases();
    } catch (error) {
      console.log(
        `  ${c.brightRed}${sym.cross}${c.reset} ${c.red}Could not reach GitHub: ${error.message}${c.reset}`
      );
      console.log();
      console.log(
        c.yellow + `  ${sym.warning} The databases will be downloaded on first use.${c.reset}`
      );
      results = CONFIG.specs.map((spec) => ({
        id: spec.id,
        name: spec.name,
        spec,
        status: 'failed',
        reason: 'release list unavailable',
      }));
      printSectionFooter();
      printWelcomeScreen(results);
      return;
    }

    // Resolve everything up front so the byte total is known before the first
    // download starts, and so a DB missing from the release fails instantly.
    const plan = CONFIG.specs.map((spec) => {
      const present =
        fs.existsSync(path.join(CONFIG.dataDir, spec.fileName)) &&
        fs.existsSync(path.join(CONFIG.dataDir, spec.manifestName));
      try {
        return { spec, present, resolved: resolveDbRelease(releases, spec), reason: null };
      } catch (error) {
        return { spec, present, resolved: null, reason: error.message };
      }
    });

    const pending = plan.filter((entry) => !entry.present && entry.resolved);
    if (pending.length > 0) {
      const bytes = pending.reduce((sum, entry) => sum + (entry.resolved.dbAsset.size || 0), 0);
      console.log(
        `  ${c.brightCyan}${sym.info}${c.reset} ${c.white}${pending.length} database(s) to download${c.reset} ${c.dim}(${formatBytes(bytes)})${c.reset}`
      );
      console.log();
    }

    for (let i = 0; i < plan.length; i++) {
      results.push(await installDb(plan[i], i + 1, plan.length));
    }

    printSummary(results);
    printSectionFooter();
    printWelcomeScreen(results);
  } catch (error) {
    console.error();
    console.error(c.brightRed + `  ${sym.cross} Installation error: ${error.message}${c.reset}`);
    console.error();
    console.log(
      c.yellow + `  ${sym.warning} Missing databases will be downloaded on first use.${c.reset}`
    );
    console.log();
    printWelcomeScreen(results);
  } finally {
    cleanup();
  }
}

// Run the installer
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(0); // Don't fail npm install
});
