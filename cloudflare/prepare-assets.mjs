/**
 * Prepare the Docusaurus build output for Cloudflare.
 *
 * The site is published as two Cloudflare projects because the free plan
 * applies its static file quota (20,000 files) to each project separately:
 *
 *   Worker  "docusaurus-docs"  -> website/build        (en, fr, zh-CN)
 *   Pages   "docusaurus-pages" -> website/build-pages  (pt-BR, ko)
 *
 * The Worker proxies the Pages-owned locale prefixes to the Pages project, so
 * the whole site stays reachable through a single URL.
 *
 * This script moves the Pages locales out of the Worker build, rewrites
 * _redirects into the syntax Cloudflare accepts, and checks both sides against
 * the quotas.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const WORKER_BUILD_DIR = 'website/build';
const PAGES_BUILD_DIR = 'website/build-pages';

const LIMITS = {
  /**
   * Cloudflare allows 20,000 static files per Worker version, and per Pages
   * deployment.
   */
  files: Number(process.env.CF_ASSET_FILE_LIMIT ?? 20_000),
  /** Cloudflare allows 25 MiB per static file. */
  fileSizeBytes: 25 * 1024 * 1024,
  /** Cloudflare _redirects: 2,100 rules (2,000 static + 100 dynamic). */
  redirectRules: 2_100,
};

/** The only status codes Cloudflare _redirects accepts. */
const SUPPORTED_REDIRECT_STATUS_CODES = new Set([200, 301, 302, 303, 307, 308]);

async function main() {
  const workerDir = path.resolve(process.cwd(), WORKER_BUILD_DIR);
  const pagesDir = path.resolve(process.cwd(), PAGES_BUILD_DIR);
  const pagesLocales = readPagesLocales();

  await exitIfMissing(workerDir, 'Worker build directory');
  await exitIfLocalesMissing(workerDir, pagesLocales);
  await splitPagesLocales(workerDir, pagesDir, pagesLocales);
  await copyHeadersFile(workerDir, pagesDir);

  const redirects = await sanitizeRedirects(path.join(workerDir, '_redirects'));
  const report = {
    worker: {
      label: WORKER_BUILD_DIR,
      ...(await collectBuildStats(await listFiles(workerDir))),
    },
    pages: {
      label: PAGES_BUILD_DIR,
      ...(await collectBuildStats(await listFiles(pagesDir))),
    },
    redirects,
  };

  reportRedirects(report.redirects);
  reportBuild(report);
  exitOnExceededLimits(report);
}

/**
 * Which locales the Pages project serves; everything else stays on the Worker.
 */
function readPagesLocales() {
  return (process.env.PAGES_LOCALES ?? 'pt-BR,ko')
    .split(',')
    .map((locale) => locale.trim())
    .filter(Boolean);
}

/**
 * Move the Pages locales instead of copying them: the Worker must not keep a
 * copy, or it would blow through its own 20,000 file quota.
 */
async function splitPagesLocales(workerDir, pagesDir, locales) {
  await fs.rm(pagesDir, {recursive: true, force: true});
  await fs.mkdir(pagesDir, {recursive: true});

  for (const locale of locales) {
    await fs.rename(path.join(workerDir, locale), path.join(pagesDir, locale));
  }

  console.log(`[prepare-assets] moved to Pages: ${locales.join(', ')}`);
}

/**
 * Pages serves its locales under the same paths as the Worker, so the caching
 * rules from _headers apply there too.
 */
async function copyHeadersFile(workerDir, pagesDir) {
  const headersFile = '_headers';

  try {
    await fs.copyFile(
      path.join(workerDir, headersFile),
      path.join(pagesDir, headersFile),
    );
    console.log('[prepare-assets] copied _headers to the Pages build');
  } catch {
    // The build has no _headers file: nothing to copy.
  }
}

async function exitIfMissing(target, description) {
  try {
    await fs.access(target);
  } catch {
    console.error(`[prepare-assets] ${description} not found: ${target}`);
    console.error('[prepare-assets] run "pnpm build:website" first');
    process.exit(1);
  }
}

async function exitIfLocalesMissing(workerDir, locales) {
  const missing = [];
  for (const locale of locales) {
    try {
      await fs.access(path.join(workerDir, locale));
    } catch {
      missing.push(locale);
    }
  }

  if (missing.length > 0) {
    console.error(
      `[prepare-assets] PAGES_LOCALES lists locales that were not built: ${missing.join(', ')}`,
    );
    console.error(
      '[prepare-assets] align DOCUSAURUS_LOCALES with PAGES_LOCALES',
    );
    process.exit(1);
  }
}

async function listFiles(dir) {
  const files = [];

  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function collectBuildStats(files) {
  let totalBytes = 0;
  let largestFile = {path: files[0] ?? '', size: 0};

  for (const file of files) {
    const {size} = await fs.stat(file);
    totalBytes += size;
    if (size > largestFile.size) {
      largestFile = {path: file, size};
    }
  }

  return {fileCount: files.length, totalBytes, largestFile};
}

/**
 * Rewrite _redirects into the subset of rules Cloudflare understands:
 *
 *   - domain-level sources ("https://v2.docusaurus.io/*") are Netlify-only and
 *     target docusaurus.io, so they are dropped;
 *   - the Netlify forced-redirect marker ("301!") is not part of the
 *     Cloudflare grammar, so it is stripped (Cloudflare always prefers the
 *     redirect over a matching asset anyway);
 *   - status codes outside Cloudflare's set (Netlify's custom "404" rules) are
 *     dropped; not_found_handling: "404-page" already serves the nearest
 *     404.html, which is what those rules were emulating.
 */
async function sanitizeRedirects(redirectsPath) {
  const lines = await readLines(redirectsPath);
  if (lines === null) {
    return {ruleCount: 0, droppedCount: 0, droppedByReason: {}};
  }

  const droppedByReason = {};
  const keptLines = [];

  for (const line of lines) {
    if (!isRule(line)) {
      keptLines.push(line);
      continue;
    }

    const dropReason = findDropReason(parseRule(line));
    if (dropReason) {
      droppedByReason[dropReason] = (droppedByReason[dropReason] ?? 0) + 1;
      continue;
    }

    keptLines.push(formatRule(parseRule(line)));
  }

  const droppedCount = Object.values(droppedByReason).reduce(
    (total, count) => total + count,
    0,
  );
  if (droppedCount > 0) {
    await fs.writeFile(redirectsPath, buildRedirectsFile(keptLines));
  }

  return {
    ruleCount: keptLines.filter(isRule).length,
    droppedCount,
    droppedByReason,
  };
}

function parseRule(line) {
  const [source, destination, status] = line.trim().split(/\s+/);
  return {
    source,
    destination,
    // Netlify marks forced redirects with a trailing "!", Cloudflare does not.
    status: status?.replace(/!$/, ''),
  };
}

/** @returns {string | null} the reason to drop the rule, or null to keep it. */
function findDropReason({source, status}) {
  if (/^https?:\/\//i.test(source)) {
    return 'domain-level source (Netlify-only)';
  }
  if (status && !SUPPORTED_REDIRECT_STATUS_CODES.has(Number(status))) {
    return `unsupported status code "${status}"`;
  }
  return null;
}

function formatRule({source, destination, status}) {
  return [source, destination, status].filter(Boolean).join(' ');
}

function buildRedirectsFile(keptLines) {
  const banner = [
    '# This file was rewritten by cloudflare/prepare-assets.mjs.',
    '# Rules Cloudflare _redirects cannot express were removed: domain-level',
    '# sources, Netlify "301!" markers and custom 404 status codes.',
    '',
  ];
  return `${[...banner, ...keptLines].join('\n').trimEnd()}\n`;
}

/** @returns {Promise<string[] | null>} null when the file does not exist. */
async function readLines(filePath) {
  try {
    return (await fs.readFile(filePath, 'utf8')).split(/\r?\n/);
  } catch {
    return null;
  }
}

function isRule(line) {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith('#');
}

function reportRedirects({ruleCount, droppedCount, droppedByReason}) {
  if (droppedCount === 0) {
    console.log('[prepare-assets] _redirects: nothing to rewrite');
    return;
  }
  console.log(
    `[prepare-assets] _redirects: kept ${ruleCount}, dropped ${droppedCount} rule(s) Cloudflare cannot read`,
  );
  for (const [reason, count] of Object.entries(droppedByReason)) {
    console.log(`  - ${reason}: ${count}`);
  }
}

function reportBuild({worker, pages, redirects}) {
  console.log('[prepare-assets] build output');
  for (const side of [worker, pages]) {
    console.log(`  ${side.label}`);
    console.log(
      `    files:        ${formatCount(side.fileCount)} / ${formatCount(LIMITS.files)}`,
    );
    console.log(`    total size:   ${formatBytes(side.totalBytes)}`);
    console.log(`    largest file: ${formatBytes(side.largestFile.size)}`);
  }
  console.log(
    `    redirects:    ${formatCount(redirects.ruleCount)} / ${formatCount(LIMITS.redirectRules)} (Worker only)`,
  );
}

function exitOnExceededLimits({worker, pages, redirects}) {
  const problems = [];

  for (const side of [worker, pages]) {
    if (side.fileCount > LIMITS.files) {
      problems.push(
        `${side.label} has ${side.fileCount} files, over the ${LIMITS.files} limit`,
      );
    }
    if (side.largestFile.size > LIMITS.fileSizeBytes) {
      const name = path.basename(side.largestFile.path);
      problems.push(
        `${side.label}: ${name} is ${formatBytes(side.largestFile.size)}, over the 25 MiB limit`,
      );
    }
  }

  if (redirects.ruleCount > LIMITS.redirectRules) {
    problems.push(
      `${redirects.ruleCount} redirect rules exceeds the ${LIMITS.redirectRules} limit`,
    );
  }

  if (problems.length === 0) {
    console.log(
      '[prepare-assets] OK: both projects are deployable to Cloudflare',
    );
    return;
  }

  console.error('[prepare-assets] FAILED:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function formatCount(count) {
  return count.toLocaleString('en-US');
}

await main();
