/**
 * Export Crowdin translations into website/i18n/<locale>/**.
 *
 * Why this exists: `crowdin download` needs the manager or developer role on
 * the Crowdin project, but a translator account may still *read* every source
 * string and every translation through the API. This script rebuilds the
 * translation files from that data, using the same source -> output mapping as
 * crowdin-v2.yaml.
 *
 * How the rebuild works: for each translatable string Crowdin stores the
 * source text and the translated text. Walking the source file and swapping
 * each source text for its translation reproduces the file. Code blocks, JSX
 * and imports are not translatable strings, so they are carried over untouched.
 * Coverage is whatever the community has translated; untranslated strings keep
 * their English text.
 *
 * Implementation notes: the project has ~105k strings, and Crowdin's list
 * endpoints fail with HTTP 500 past a few thousand rows of offset. Translations
 * are therefore requested per batch of string ids, never by offset.
 *
 * Usage:
 *   CROWDIN_PERSONAL_TOKEN=... node cloudflare/crowdin-export.mjs
 *
 * Environment:
 *   CROWDIN_PERSONAL_TOKEN  required, a translator account is enough
 *   CROWDIN_PROJECT_ID      default 428890 (facebook/docusaurus)
 *   CROWDIN_LOCALES         default "zh-CN"; comma separated
 */

import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const API = 'https://api.crowdin.com/api/v2';
const PROJECT_ID = process.env.CROWDIN_PROJECT_ID ?? '428890';
const TOKEN = process.env.CROWDIN_PERSONAL_TOKEN;
const LOCALES = (process.env.CROWDIN_LOCALES ?? 'zh-CN').split(',').map((l) => l.trim()).filter(Boolean);
const PAGE_SIZE = 500;
/** String ids per translations request; keeps the URL short and the API happy. */
const ID_BATCH_SIZE = 400;
const CONCURRENCY = 4;

/**
 * Source path -> output path, mirroring the "files" section of
 * crowdin-v2.yaml. The remainder of the source path is appended to the target.
 */
const RULES = [
  {source: '/website/docs/', target: 'docusaurus-plugin-content-docs/current/'},
  {source: '/website/versioned_docs/', target: 'docusaurus-plugin-content-docs/'},
  {source: '/website/community/', target: 'docusaurus-plugin-content-docs-community/current/'},
  {source: '/website/blog/', target: 'docusaurus-plugin-content-blog/'},
  {source: '/website/src/pages/', target: 'docusaurus-plugin-content-pages/'},
  {source: '/website/i18n/en/', target: ''},
];

/** Extensions crowdin-v2.yaml asks Crowdin to ignore. */
const IGNORED_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.css']);

async function main() {
  if (!TOKEN) {
    console.error('[crowdin-export] CROWDIN_PERSONAL_TOKEN is required');
    process.exit(1);
  }

  if (process.env.CROWDIN_REWRITE_ONLY === '1') {
    console.log('[crowdin-export] rewrite-only mode: fixing relative asset URLs in place');
    await rewriteExisting();
    return;
  }

  console.log('[crowdin-export] fetching project files and source strings...');
  const files = await listProjectFiles();
  const stringsByFile = await listStringsByFile();
  const targets = files.map((file) => ({file, rule: findRule(file.path), strings: stringsByFile.get(file.id) ?? []}))
    .filter((target) => target.rule !== null && target.strings.length > 0);
  const stringIds = targets.flatMap((target) => target.strings.map((string) => string.id));

  console.log(`[crowdin-export] ${files.length} project files, ${targets.length} local targets, ${stringIds.length} strings`);

  for (const locale of LOCALES) {
    console.log(`[crowdin-export] fetching ${locale} translations (${Math.ceil(stringIds.length / ID_BATCH_SIZE)} batches)...`);
    const translations = await listTranslations(locale, stringIds);
    const stats = await exportLocale({targets, translations, locale});
    console.log(`[crowdin-export] ${locale}: ${stats.written} files written, ${stats.replaced} segments replaced, ${stats.missed} unmatched`);
  }

  console.log('');
  console.log('[crowdin-export] done');
}

async function listProjectFiles() {
  const files = [];
  for await (const page of pages(`/projects/${PROJECT_ID}/files`)) {
    files.push(...page.map((file) => ({id: file.id, path: file.path})));
  }
  return files;
}

/** Every source string, grouped by the Crowdin file id it belongs to. */
async function listStringsByFile() {
  const byFile = new Map();

  for await (const page of pages(`/projects/${PROJECT_ID}/strings`)) {
    for (const string of page) {
      if (!byFile.has(string.fileId)) {
        byFile.set(string.fileId, []);
      }
      byFile.get(string.fileId).push({id: string.id, text: string.text});
    }
  }

  return byFile;
}

/** stringId -> translated text, for one language. */
async function listTranslations(locale, stringIds) {
  const batches = chunk(stringIds, ID_BATCH_SIZE);
  const byStringId = new Map();

  await forEachConcurrent(batches, CONCURRENCY, async (batch) => {
    const endpoint = `/projects/${PROJECT_ID}/languages/${locale}/translations?stringIds=${batch.join(',')}&limit=${batch.length}`;
    const page = await api(endpoint);
    for (const record of page.data.map((item) => item.data)) {
      if (record.stringId !== undefined && record.text) {
        byStringId.set(record.stringId, record.text);
      }
    }
  });

  return byStringId;
}

async function exportLocale({targets, translations, locale}) {
  const stats = {written: 0, replaced: 0, missed: 0, unrepairable: 0};

  await forEachConcurrent(targets, CONCURRENCY, async ({file, rule, strings}) => {
    const source = await readSourceFile(rule.sourcePath);
    if (source === null) {
      return;
    }

    const rebuilt = rebuild(source, strings, translations);
    stats.replaced += rebuilt.replaced;
    stats.missed += rebuilt.missed;

    if (rebuilt.replaced === 0) {
      return;
    }

    const outputPath = path.resolve(process.cwd(), 'website/i18n', locale, rule.outputPath);
    await fs.mkdir(path.dirname(outputPath), {recursive: true});
    const repaired = await repairDroppedInlineCode(
      await rewriteRelativeAssets(rebuilt.content, rule.sourcePath),
      MARKDOWN_EXTENSIONS.has(path.extname(rule.outputPath)),
    );
    if (!repaired.ok) {
      stats.unrepairable += 1;
      return;
    }
    await fs.writeFile(outputPath, repaired.content);
    stats.written += 1;
  });

  return stats;
}

function findRule(sourcePath) {
  const rule = RULES.find((candidate) => sourcePath.startsWith(candidate.source));
  if (!rule) {
    return null;
  }

  const relative = sourcePath.slice(rule.source.length);
  if (IGNORED_EXTENSIONS.has(path.extname(relative))) {
    return null;
  }

  return {sourcePath, outputPath: `${rule.target}${relative}`};
}

/**
 * Point relative asset URLs at the source tree.
 *
 * A translated file lives under website/i18n/<locale>/..., where "./demo.png"
 * no longer resolves: the image only exists next to the English source. The
 * MDX loader understands "@site/" paths (resolved from the site directory), so
 * rewriting "./demo.png" into "@site/docs/api/misc/logger/demo.png" keeps every
 * locale pointing at the same image.
 *
 * Links to other documents are left alone on purpose: the i18n tree mirrors the
 * source tree, so relative doc links keep working and stay locale-aware.
 */
async function rewriteRelativeAssets(content, sourcePath) {
  const sourceDir = path.dirname(path.resolve(process.cwd(), sourcePath.slice(1)));
  const withImports = await restoreSourceImports(content, sourcePath);
  const frontMatter = withImports.match(FRONT_MATTER_PATTERN);

  if (!frontMatter) {
    return rewriteUrls(withImports, sourceDir);
  }

  const [whole, open, yaml, close] = frontMatter;
  return `${open}${await rewriteFrontMatter(yaml, sourceDir)}${close}${await rewriteUrls(withImports.slice(whole.length), sourceDir)}`;
}

/**
 * Import statements are code, not prose, but Crowdin hands them to translators
 * like any other string: one pt-BR translator renamed "ShowcaseCarouselV2Theming"
 * to "ShowcaseCarouselV2Temas", which left the component undefined at render
 * time. Whenever a translation has the same number of import lines as the
 * source, the source wins.
 */
async function restoreSourceImports(content, sourcePath) {
  const source = await readSourceFile(sourcePath);
  if (source === null) {
    return content;
  }

  const sourceImports = [...source.matchAll(IMPORT_LINE_PATTERN)].map((match) => match[0]);
  const contentImports = [...content.matchAll(IMPORT_LINE_PATTERN)].map((match) => match[0]);
  if (sourceImports.length === 0 || sourceImports.length !== contentImports.length) {
    return content;
  }

  let result = content;
  for (const [index, translated] of contentImports.entries()) {
    if (translated !== sourceImports[index]) {
      result = result.replace(translated, sourceImports[index]);
    }
  }

  return result;
}

/** Any line that is an ES import, including the side-effect form. */
const IMPORT_LINE_PATTERN = /^import\b[^\n]*$/gm;

/**
 * Front matter values must be quoted once they start with "@" (YAML reserves
 * "@" as the start of a scalar), so these lines are rewritten as a whole.
 */
async function rewriteFrontMatter(yaml, sourceDir) {
  let result = yaml;

  for (const match of [...yaml.matchAll(FRONT_MATTER_ASSET_PATTERN)].reverse()) {
    const [line, prefix, , url] = match;
    // Values rewritten by an earlier run are already "@site/...".
    const sitePath = url.startsWith('@site/') ? url : await resolveSiteAssetPath(url, sourceDir);
    if (sitePath !== null) {
      result = result.replace(line, `${prefix}"${sitePath}"`);
    }
  }

  return result;
}

/**
 * Put back inline-code backticks that a translation dropped.
 *
 * Translators sometimes write "<Redirect>" where the English said
 * "`<Redirect>`". Without the backticks MDX reads it as an unclosed JSX tag
 * and the build fails. Only tags the source itself writes as inline code are
 * touched, and never inside an existing code span.
 */
/** @returns {Promise<{content: string, ok: boolean}>} */
async function repairDroppedInlineCode(content, isMarkdown) {
  if (!isMarkdown) {
    // JSON translation files are not compiled as MDX; nothing to repair.
    return {content, ok: true};
  }

  let result = content;

  // Ask the real MDX compiler what is broken, then fix exactly that spot:
  // translators sometimes drop the backticks around inline code such as
  // "`<Redirect>`", which MDX then reads as an unclosed JSX tag.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const error = await compileError(result);
    if (error === null) {
      return {content: result, ok: true};
    }

    const match = error.match(/closing tag for `<([^>`]+)>` \((\d+):(\d+)/);
    if (!match) {
      break;
    }

    const patched = wrapTagInBackticks(result, Number(match[2]), Number(match[3]), match[1]);
    if (patched === result) {
      break;
    }
    result = patched;
  }

  // Some translations mangle the markup beyond repair; the caller then falls
  // back to the English source for that page.
  return {content, ok: false};
}

/** @returns {Promise<string | null>} the first compile error message, or null. */
async function compileError(content) {
  const {compile} = await loadMdxCompiler();
  try {
    await compile(content, {format: 'mdx'});
    return null;
  } catch (error) {
    return String(error.message);
  }
}

let mdxCompiler;

function loadMdxCompiler() {
  if (!mdxCompiler) {
    const require = createRequire(
      path.resolve(process.cwd(), 'packages/docusaurus-mdx-loader/package.json'),
    );
    mdxCompiler = import(pathToFileURL(require.resolve('@mdx-js/mdx')).href);
  }
  return mdxCompiler;
}

/** Wraps the tag at the reported position in backticks. */
function wrapTagInBackticks(content, line, column, tag) {
  const lines = content.split('\n');
  const index = line - 1;
  const original = lines[index];
  if (original === undefined) {
    return content;
  }

  const start = column - 1;
  const opening = `<${tag}>`;
  // The compiler only reports tags outside code spans, so trusting its
  // position is enough; checking the previous character misfires when a
  // preceding code span happens to end right before the tag.
  const at = original.startsWith(opening, start) ? start : original.indexOf(opening, start);
  if (at < 0) {
    return content;
  }

  lines[index] = `${original.slice(0, at)}\`${opening}\`${original.slice(at + opening.length)}`;
  return lines.join('\n');
}

async function rewriteUrls(text, sourceDir) {
  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(FENCED_BLOCK_PATTERN)) {
    result += await rewriteUrlsInText(text.slice(lastIndex, match.index), sourceDir);
    // Docusaurus compiles ```mdx-code-block fences (the docs import
    // components and CSS modules inside them), so those need rewriting too;
    // ordinary code samples must stay exactly as the author wrote them.
    result +=
      match[1].trim() === 'mdx-code-block'
        ? await rewriteUrlsInText(match[0], sourceDir)
        : match[0];
    lastIndex = match.index + match[0].length;
  }

  return result + (await rewriteUrlsInText(text.slice(lastIndex), sourceDir));
}

/** Fenced code block, capturing the info string after the opening fence. */
const FENCED_BLOCK_PATTERN = /^[ \t]*\`\`\`([^\n]*)\n[\s\S]*?^[ \t]*\`\`\`[ \t]*$/gm;

async function rewriteUrlsInText(text, sourceDir) {
  const urls = new Map();
  for (const match of text.matchAll(URL_PATTERN)) {
    urls.set(match[2], isModuleReference(match[1]));
  }

  let result = text;
  for (const [url, isModule] of urls) {
    const sitePath = await resolveSiteAssetPath(url, sourceDir, isModule);
    if (sitePath !== null) {
      result = result.split(url).join(sitePath);
    }
  }

  return result;
}

/** "import ... from", "import" and "require(...)" are module references. */
function isModuleReference(prefix) {
  return (
    prefix.startsWith('require') ||
    prefix.startsWith('from') ||
    prefix.startsWith('import')
  );
}

/** @returns {Promise<string | null>} the "@site/..." path, or null to keep the URL. */
async function resolveSiteAssetPath(url, sourceDir, isModule = false) {
  if (!url.startsWith('./') && !url.startsWith('../')) {
    return null;
  }

  const [pathname] = url.split(/[?#]/);
  const target = path.resolve(sourceDir, pathname);
  if (!isModule && CONTENT_EXTENSIONS.has(path.extname(target))) {
    // Markdown links to other documents stay relative so they keep pointing at
    // the localized copy. Module imports of an .mdx partial are different: the
    // partial is not translated, so the import has to reach the source tree.
    return null;
  }

  const resolved = await resolveExistingFile(target);
  if (resolved === null || (!isModule && CONTENT_EXTENSIONS.has(path.extname(resolved)))) {
    return null;
  }

  const siteDir = path.resolve(process.cwd(), 'website');
  return `@site/${path.relative(siteDir, resolved).replaceAll(path.sep, '/')}`;
}

/** Mirrors webpack resolution: exact path, then extensions, then index files. */
async function resolveExistingFile(target) {
  if (await fileExists(target)) {
    return target;
  }

  for (const extension of RESOLVE_EXTENSIONS) {
    if (await fileExists(`${target}${extension}`)) {
      return `${target}${extension}`;
    }
  }

  for (const extension of RESOLVE_EXTENSIONS) {
    const indexFile = path.join(target, `index${extension}`);
    if (await fileExists(indexFile)) {
      return indexFile;
    }
  }

  return null;
}

/** Markdown/mdx URL positions: links, images, src/href attributes, requires. */
const URL_PATTERN = /(\]\(|\bsrc=["']|\bhref=["']|\brequire\(["']|\bfrom\s+["']|\bimport\s+["'])([^)"'\s]+)/g;

/** A front matter line whose whole value is a relative path. */
const FRONT_MATTER_ASSET_PATTERN = /^(\s*[\w-]+:\s*)(["']?)((?:\.\.?\/|@site\/)[^\s"']+)\2\s*$/gm;

/** Leading "---\n...\n---" block, with its delimiters kept for reassembly. */
const FRONT_MATTER_PATTERN = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

const CONTENT_EXTENSIONS = new Set(['.md', '.mdx']);

/** Extensions webpack would try for an import without one. */
const RESOLVE_EXTENSIONS = [
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '.mdx',
  '.md',
  '.css',
  '.json',
  '.svg',
  '.png',
];

/** Files the MDX compiler can validate. */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Inverse of findRule, for rewrite-only runs over an existing i18n tree. */
function findSourcePath(i18nRelativePath) {
  const rules = [...RULES].sort((a, b) => b.target.length - a.target.length);

  for (const rule of rules) {
    if (i18nRelativePath.startsWith(rule.target)) {
      return `${rule.source}${i18nRelativePath.slice(rule.target.length)}`;
    }
  }

  return null;
}

/** Rewrites already exported files without touching the Crowdin API. */
async function rewriteExisting() {
  for (const locale of LOCALES) {
    const localeDir = path.resolve(process.cwd(), 'website/i18n', locale);
    let rewritten = 0;

    for await (const file of walk(localeDir)) {
      const relative = path.relative(localeDir, file).replaceAll(path.sep, '/');
      const sourcePath = findSourcePath(relative);
      if (sourcePath === null) {
        continue;
      }

      const content = await fs.readFile(file, 'utf8');
      const rewrittenContent = await rewriteRelativeAssets(content, sourcePath);
      if (process.env.CROWDIN_DEBUG === '1') {
        console.log(`[debug] ${relative} | source=${sourcePath} | changed=${rewrittenContent !== content}`);
      }
      const fixed = await repairDroppedInlineCode(
        rewrittenContent,
        MARKDOWN_EXTENSIONS.has(path.extname(relative)),
      );
      if (!fixed.ok) {
        // Broken beyond repair: drop the translation so Docusaurus serves the
        // English source for this page instead of failing the build.
        await fs.rm(file);
        console.log(`[crowdin-export] dropped (unrepairable): ${relative}`);
        continue;
      }
      if (fixed.content !== content) {
        await fs.writeFile(file, fixed.content);
        rewritten += 1;
      }
    }

    console.log(`[crowdin-export] ${locale}: ${rewritten} file(s) rewritten`);
  }
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, {withFileTypes: true});
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

async function readSourceFile(sourcePath) {
  try {
    return await fs.readFile(path.resolve(process.cwd(), sourcePath.slice(1)), 'utf8');
  } catch {
    // The file exists on Crowdin but not in this checkout (e.g. another branch).
    return null;
  }
}

function rebuild(source, strings, translations) {
  let content = source;
  let cursor = 0;
  let replaced = 0;
  let missed = 0;

  for (const string of strings) {
    const sourceText = string.text;
    const targetText = translations.get(string.id);
    if (!sourceText || targetText === undefined || targetText === sourceText) {
      continue;
    }

    // Crowdin does not always list strings in file order (JSON files in
    // particular), so fall back to a search from the start of the file.
    const forwardIndex = content.indexOf(sourceText, cursor);
    const index = forwardIndex >= 0 ? forwardIndex : content.indexOf(sourceText);
    if (index < 0) {
      missed += 1;
      continue;
    }

    content = content.slice(0, index) + targetText + content.slice(index + sourceText.length);
    if (index >= cursor) {
      cursor = index + targetText.length;
    }
    replaced += 1;
  }

  return {content, replaced, missed};
}

/** Yields one page of `data.data` items at a time. */
async function* pages(endpoint) {
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const response = await api(`${endpoint}${separator}limit=${PAGE_SIZE}&offset=${offset}`);
    const items = response.data.map((item) => item.data);
    yield items;
    if (items.length < PAGE_SIZE) {
      return;
    }
  }
}

async function api(endpoint) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${API}${endpoint}`, {
        headers: {Authorization: `Bearer ${TOKEN}`},
      });

      if (response.ok) {
        return response.json();
      }

      // Crowdin throttles bursts; back off instead of losing the page.
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < 5) {
        continue;
      }

      throw new Error(`${endpoint.slice(0, 120)} -> HTTP ${response.status}`);
    } catch (error) {
      // Network hiccups (proxy, TLS, DNS) are worth retrying too.
      if (attempt < 5) {
        continue;
      }
      throw error;
    }
  }
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function forEachConcurrent(items, concurrency, callback) {
  const queue = [...items];
  const workers = Array.from({length: Math.min(concurrency, queue.length)}, async () => {
    while (queue.length > 0) {
      await callback(queue.shift());
    }
  });
  await Promise.all(workers);
}

await main();
