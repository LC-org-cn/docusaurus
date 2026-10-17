/**
 * Cloudflare Worker for the Docusaurus site.
 *
 * Static pages are served straight from the ASSETS binding. This script only
 * runs for the routes listed in `assets.run_worker_first` ("/api/*"), plus any
 * request that matches no asset at all.
 *
 * Bindings (see wrangler.jsonc):
 *   DB      D1 database   "docusaurus-db"     - docs page feedback
 *   KV      KV namespace  "docusaurus-kv"     - derived counters and caching
 *   BUCKET  R2 bucket     "docusaurus-assets" - bulk storage, kept under 1 GB
 *   ASSETS  static assets "./website/build"   - the built site
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/** The R2 bucket is expected to stay below this size. */
const R2_BUDGET_BYTES = 1024 * 1024 * 1024;

/** Set once the feedback table has been checked in this isolate. */
let schemaReady = false;

export default {
  /**
   * @param {Request} request
   * @param {object} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await routeApiRequest(request, env, url);
    } catch (error) {
      return apiError(`unhandled error: ${error.message}`, 500);
    }
  },
};

async function routeApiRequest(request, env, url) {
  const route = `${request.method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/health':
      return getHealth(env);
    case 'GET /api/storage':
      return getStorageUsage(env);
    case 'GET /api/feedback':
      return getFeedback(url, env);
    case 'POST /api/feedback':
      return postFeedback(request, env);
    default:
      return apiError(`unknown route: ${route}`, 404);
  }
}

/** GET /api/health - verifies every binding is reachable. */
async function getHealth(env) {
  const bindings = {
    d1: await checkD1(env),
    kv: await checkKv(env),
    r2: await checkR2(env),
  };

  return json({
    ok: Object.values(bindings).every((status) => status === 'ok'),
    worker: 'docusaurus-docs',
    bindings,
    time: new Date().toISOString(),
  });
}

/** GET /api/storage - R2 usage, so the 1 GB budget stays visible. */
async function getStorageUsage(env) {
  const usage = await measureBucket(env.BUCKET);

  return json({
    bucket: 'docusaurus-assets',
    ...usage,
    budgetBytes: R2_BUDGET_BYTES,
    withinBudget: usage.bytes <= R2_BUDGET_BYTES,
  });
}

/** GET /api/feedback?path=/docs/x - aggregates straight from D1. */
async function getFeedback(url, env) {
  const pagePath = url.searchParams.get('path');
  if (!pagePath) {
    return apiError('missing "path" query parameter');
  }

  await ensureSchema(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(helpful), 0) AS helpful
     FROM feedback
     WHERE path = ?`,
  )
    .bind(pagePath)
    .first();

  return json(buildFeedbackCounts(pagePath, row));
}

/** POST /api/feedback - body: {"path": "/docs/x", "helpful": true} */
async function postFeedback(request, env) {
  const parsed = await parseFeedbackBody(request);
  if (parsed.error) {
    return apiError(parsed.error);
  }

  const {path: pagePath, helpful} = parsed;

  await ensureSchema(env);
  await env.DB.prepare('INSERT INTO feedback (path, helpful) VALUES (?, ?)')
    .bind(pagePath, helpful ? 1 : 0)
    .run();
  await bumpCounter(env.KV, `feedback:${pagePath}`);

  return json({ok: true, path: pagePath, helpful});
}

async function parseFeedbackBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return {error: 'body must be JSON'};
  }

  const pagePath = body?.path;
  if (
    typeof pagePath !== 'string' ||
    pagePath.length === 0 ||
    pagePath.length > 512
  ) {
    return {error: '"path" must be a string of 1 to 512 characters'};
  }
  if (typeof body.helpful !== 'boolean') {
    return {error: '"helpful" must be a boolean'};
  }

  return {path: pagePath, helpful: body.helpful};
}

function buildFeedbackCounts(pagePath, row) {
  const total = Number(row?.total ?? 0);
  const helpful = Number(row?.helpful ?? 0);
  return {path: pagePath, total, helpful, notHelpful: total - helpful};
}

async function checkD1(env) {
  try {
    const row = await env.DB.prepare('SELECT 1 AS ok').first();
    return row?.ok === 1 ? 'ok' : 'unexpected response';
  } catch (error) {
    return `error: ${error.message}`;
  }
}

async function checkKv(env) {
  try {
    await env.KV.get('health');
    return 'ok';
  } catch (error) {
    return `error: ${error.message}`;
  }
}

async function checkR2(env) {
  try {
    await env.BUCKET.list({limit: 1});
    return 'ok';
  } catch (error) {
    return `error: ${error.message}`;
  }
}

async function measureBucket(bucket) {
  let cursor;
  let objects = 0;
  let bytes = 0;

  // Bounded walk: enough to warn about the budget without unbounded work.
  for (let page = 0; page < 10; page += 1) {
    const listed = await bucket.list({limit: 1000, cursor});
    for (const object of listed.objects) {
      objects += 1;
      bytes += object.size;
    }
    if (!listed.truncated) {
      break;
    }
    cursor = listed.cursor;
  }

  return {objects, bytes};
}

/** Counters are derived data: KV is a cache, never the source of truth. */
async function bumpCounter(kv, key) {
  const current = Number((await kv.get(key)) ?? 0);
  await kv.put(key, String(current + 1), {expirationTtl: 60 * 60 * 24 * 30});
}

/**
 * The table is created on first write so a fresh database bootstraps itself.
 */
async function ensureSchema(env) {
  if (schemaReady) {
    return;
  }

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS feedback (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       path TEXT NOT NULL,
       helpful INTEGER NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_feedback_path ON feedback (path)',
  ).run();

  schemaReady = true;
}

function json(data, status = 200) {
  return new Response(`${JSON.stringify(data, null, 2)}\n`, {
    status,
    headers: JSON_HEADERS,
  });
}

function apiError(error, status = 400) {
  return json({ok: false, error}, status);
}
