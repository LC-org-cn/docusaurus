/**
 * Post-process the Docusaurus build output for Cloudflare Workers static
 * assets.
 *
 * Run after `pnpm build:website` and before `wrangler deploy`. It rewrites the
 * one file Cloudflare cannot read as-is, and fails loudly when the build output
 * exceeds a limit Cloudflare enforces at deploy time.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const LIMITS = {
  /**
   * Cloudflare Workers static assets: 20,000 files on the Free plan, 100,000
   * on Workers Paid. Override with CF_ASSET_FILE_LIMIT after upgrading.
   */
  files: Number(process.env.CF_ASSET_FILE_LIMIT ?? 20_000),
  /** Cloudflare Workers static assets: 25 MiB per file. */
  fileSizeBytes: 25 * 1024 * 1024,
  /** Cloudflare `_redirects`: 2,100 rules (2,000 static + 100 dynamic). */
  redirectRules: 2_100,
};

/** The only status codes Cloudflare Workers `_redirects` accepts. */
const SUPPORTED_REDIRECT_STATUS_CODES = new Set([200, 301, 302, 303, 307, 308]);

async function main() {
  const buildDir = path.resolve(process.cwd(), 'website/build');
  await exitIfMissing(buildDir, 'build directory');

  const redirects = await sanitizeRedirects(path.join(buildDir, '_redirects'));

  if (redirects.droppedCount > 0) {
    console.log(
      `[prepare-assets] _redirects: dropped ${redirects.droppedCount} rule(s) Cloudflare cannot read`,
    );
    for (const [reason, count] of Object.entries(redirects.droppedByReason)) {
      console.log(`  - ${reason}: ${count}`);
    }
  } else {
    console.log('[prepare-assets] _redirects: nothing to rewrite');
  }

  const report = {
    ...(await collectBuildStats(await listFiles(buildDir))),
    redirectRules: redirects.ruleCount,
  };
  reportBuild(report);
  exitOnExceededLimits(report);
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
  let largestFile = {path: files[0], size: 0};

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
 * Rewrite website/static/_redirects into the subset of rules Cloudflare
 * Workers understands:
 *
 *   - domain-level sources ("https://v2.docusaurus.io/*") are Netlify-only and
 *     target docusaurus.io, so they are dropped;
 *   - the Netlify "forced redirect" marker ("301!") is not part of the
 *     Cloudflare grammar, so it is stripped (Cloudflare always prefers the
 *     redirect over a matching asset anyway);
 *   - status codes outside Cloudflare's set (Netlify's custom "404" rules) are
 *     dropped; not_found_handling: "404-page" already serves the nearest
 *     404.html, which is what those rules were emulating.
 *
 * @returns {Promise<{ruleCount: number, droppedCount: number, droppedByReason: object}>}
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
    '# Rules Cloudflare Workers _redirects cannot express were removed:',
    '# domain-level sources, Netlify "301!" markers and custom 404 statuses.',
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

function reportBuild({fileCount, totalBytes, largestFile, redirectRules}) {
  console.log('[prepare-assets] build output');
  console.log(
    `  files:          ${formatCount(fileCount)} / ${formatCount(LIMITS.files)}`,
  );
  console.log(`  total size:     ${formatBytes(totalBytes)}`);
  console.log(`  largest file:   ${formatBytes(largestFile.size)}`);
  console.log(
    `  redirect rules: ${formatCount(redirectRules)} / ${formatCount(LIMITS.redirectRules)}`,
  );
}

function exitOnExceededLimits({fileCount, largestFile, redirectRules}) {
  const problems = [];

  if (fileCount > LIMITS.files) {
    problems.push(`${fileCount} files exceeds the ${LIMITS.files} file limit`);
  }
  if (largestFile.size > LIMITS.fileSizeBytes) {
    const name = path.basename(largestFile.path);
    problems.push(
      `${name} is ${formatBytes(largestFile.size)}, over the 25 MiB limit`,
    );
  }
  if (redirectRules > LIMITS.redirectRules) {
    problems.push(
      `${redirectRules} redirect rules exceeds the ${LIMITS.redirectRules} limit`,
    );
  }

  if (problems.length === 0) {
    console.log(
      '[prepare-assets] OK: build output is deployable to Cloudflare',
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
