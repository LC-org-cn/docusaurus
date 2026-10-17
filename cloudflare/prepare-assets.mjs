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
  /** Cloudflare Workers static assets: 20,000 files (free) / 100,000 (paid). */
  files: 100_000,
  /** Cloudflare Workers static assets: 25 MiB per file. */
  fileSizeBytes: 25 * 1024 * 1024,
  /** Cloudflare `_redirects`: 2,100 rules (2,000 static + 100 dynamic). */
  redirectRules: 2_100,
};

async function main() {
  const buildDir = path.resolve(process.cwd(), 'website/build');
  await exitIfMissing(buildDir, 'build directory');

  const files = await listFiles(buildDir);
  const stats = await collectBuildStats(files);
  const redirectRules = await sanitizeRedirects(
    path.join(buildDir, '_redirects'),
  );
  const report = {...stats, redirectRules};

  reportBuild(buildDir, report);
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
 * Cloudflare's `_redirects` only accepts path-based sources, but
 * website/static/_redirects contains Netlify rules such as
 * "https://v2.docusaurus.io/* https://docusaurus.io/:splat 301!". Those rules
 * target docusaurus.io and are meaningless on a *.workers.dev deployment, so
 * they are dropped here.
 *
 * @returns {Promise<number>} the number of rules left in the file.
 */
async function sanitizeRedirects(redirectsPath) {
  const lines = await readLines(redirectsPath);
  if (lines === null) {
    return 0;
  }

  const kept = lines.filter((line) => !isDomainLevelRule(line));
  const droppedCount = lines.length - kept.length;

  if (droppedCount === 0) {
    console.log('[prepare-assets] _redirects: no domain-level rules to drop');
  } else {
    const banner = [
      '# Domain-level rules from website/static/_redirects were removed by',
      '# cloudflare/prepare-assets.mjs: Cloudflare Workers _redirects only',
      '# supports path-based sources, and these rules target docusaurus.io.',
      '',
    ];
    const content = [...banner, ...kept].join('\n').trimEnd();
    await fs.writeFile(redirectsPath, `${content}\n`);
    console.log(
      `[prepare-assets] _redirects: dropped ${droppedCount} domain-level line(s)`,
    );
  }

  return kept.filter(isRule).length;
}

/** @returns {Promise<string[] | null>} null when the file does not exist. */
async function readLines(filePath) {
  try {
    return (await fs.readFile(filePath, 'utf8')).split(/\r?\n/);
  } catch {
    return null;
  }
}

function isDomainLevelRule(line) {
  if (!isRule(line)) {
    return false;
  }
  return /^https?:\/\//i.test(line.trim().split(/\s+/)[0]);
}

function isRule(line) {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith('#');
}

function reportBuild(
  buildDir,
  {fileCount, totalBytes, largestFile, redirectRules},
) {
  const relativeLargest = path
    .relative(buildDir, largestFile.path)
    .replaceAll(path.sep, '/');

  console.log('[prepare-assets] build output');
  console.log(
    `  files:          ${formatCount(fileCount)} / ${formatCount(LIMITS.files)}`,
  );
  console.log(`  total size:     ${formatBytes(totalBytes)}`);
  console.log(
    `  largest file:   ${formatBytes(largestFile.size)} (${relativeLargest})`,
  );
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
