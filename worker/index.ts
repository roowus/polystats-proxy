/**
 * PolyStats CORS proxy for the PolyTrack v6 API.
 *
 * The PolyTrack leaderboard API (https://vps.kodub.com/v6/) only serves
 * requests whose `Origin` header is the game's own origin, so PolyStats
 * cannot call it directly from the browser. Deploy this Cloudflare Worker
 * and point the app at it (see README).
 *
 * Usage:  https://<worker>.workers.dev/?url=<encodeURIComponent(targetUrl)>
 *
 * Deploy:
 *   cd worker
 *   npx wrangler deploy
 */

const GAME_ORIGIN = 'https://app-polytrack.kodub.com';
const ALLOWED_API_HOST = 'vps.kodub.com';

/** Origins allowed to WRITE to the catalog. Reads are open. */
const WRITE_ORIGINS = new Set([
  'https://polystats.roow.us',
  'https://polystats.vercel.app',
  'http://localhost:5173',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

interface Env {
  /** D1 database binding (see wrangler.toml). Catalog features degrade without it. */
  DB?: D1Database;
}

interface CatalogRow {
  user_id: string;
  nickname: string | null;
  saved_count: number;
  last_seen: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Create the catalog table on first use (zero-touch migrations). */
let schemaReady = false;
async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS catalog (
        user_id TEXT PRIMARY KEY,
        nickname TEXT,
        saved_count INTEGER NOT NULL DEFAULT 1,
        last_seen TEXT NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS wr_history (
        track_id TEXT NOT NULL,
        player TEXT NOT NULL,
        time_ms INTEGER NOT NULL,
        set_at TEXT NOT NULL,
        recording TEXT,
        UNIQUE(track_id, player, time_ms, set_at)
      )`
    ),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_history_track ON wr_history(track_id, time_ms)'),
  ]);
  schemaReady = true;
}

interface HistoryRow {
  track_id: string;
  player: string;
  time_ms: number;
  set_at: string;
  recording?: string | null;
}

/** WR history endpoints (backed by D1). */
async function handleHistory(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ error: 'history unavailable: D1 binding missing' }, 503);
  }
  await ensureSchema(env);

  if (request.method === 'GET') {
    const trackId = url.searchParams.get('trackId');
    if (trackId) {
      const { results } = await env.DB
        .prepare('SELECT track_id, player, time_ms, set_at, recording FROM wr_history WHERE track_id = ?1 ORDER BY set_at ASC')
        .bind(trackId)
        .all<HistoryRow>();
      return jsonResponse({ history: results });
    }
    const { results } = await env.DB
      .prepare(
        `SELECT h.track_id, h.player, h.time_ms, h.set_at
         FROM wr_history h
         JOIN (SELECT track_id, MIN(time_ms) AS best FROM wr_history GROUP BY track_id) b
           ON b.track_id = h.track_id AND b.best = h.time_ms
         ORDER BY h.track_id`
      )
      .all<HistoryRow>();
    return jsonResponse({ current_records: results });
  }

  if (request.method === 'POST') {
    const origin = request.headers.get('Origin') ?? '';
    if (!WRITE_ORIGINS.has(origin)) {
      return jsonResponse({ error: 'writes from this origin are not allowed' }, 403);
    }
    let body: { rows?: { trackId?: string; player?: string; timeMs?: number; ts?: string; recording?: string }[] };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    const rows = (body.rows ?? []).filter(
      (r) =>
        r.trackId &&
        /^[a-f0-9]{64}$/.test(r.trackId) &&
        typeof r.player === 'string' &&
        typeof r.timeMs === 'number' &&
        typeof r.ts === 'string'
    );
    if (rows.length === 0) return jsonResponse({ error: 'no valid rows' }, 400);
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO wr_history (track_id, player, time_ms, set_at, recording)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    );
    await env.DB.batch(rows.map((r) => stmt.bind(r.trackId, r.player.slice(0, 80), Math.round(r.timeMs), r.ts, r.recording ?? null)));
    return jsonResponse({ ok: true, ingested: rows.length });
  }

  return jsonResponse({ error: 'method not allowed' }, 405);
}

/** Player catalog endpoints (backed by D1; 503 when the binding is absent). */
async function handleCatalog(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ error: 'catalog unavailable: D1 binding missing' }, 503);
  }

  await ensureSchema(env);

  if (request.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 100);
    const { results } = await env.DB
      .prepare('SELECT user_id, nickname, saved_count, last_seen FROM catalog ORDER BY saved_count DESC, last_seen DESC LIMIT ?')
      .bind(limit)
      .all<CatalogRow>();
    return jsonResponse({ users: results });
  }

  if (request.method === 'DELETE') {
    const origin = request.headers.get('Origin') ?? '';
    if (!WRITE_ORIGINS.has(origin)) {
      return jsonResponse({ error: 'writes from this origin are not allowed' }, 403);
    }
    const userId = url.searchParams.get('userId');
    if (!userId || !/^[a-f0-9]{64}$/.test(userId)) {
      return jsonResponse({ error: 'userId query param must be 64-char hex' }, 400);
    }
    await env.DB.prepare('DELETE FROM catalog WHERE user_id = ?1').bind(userId).run();
    return jsonResponse({ ok: true });
  }

  if (request.method === 'POST') {
    // Only the PolyStats site may write.
    const origin = request.headers.get('Origin') ?? '';
    if (!WRITE_ORIGINS.has(origin)) {
      return jsonResponse({ error: 'writes from this origin are not allowed' }, 403);
    }
    let body: { userId?: string; nickname?: string };
    try {
      body = (await request.json()) as { userId?: string; nickname?: string };
    } catch {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    const userId = body.userId;
    if (!userId || !/^[a-f0-9]{64}$/.test(userId)) {
      return jsonResponse({ error: 'userId must be a 64-char hex string' }, 400);
    }
    const nickname = typeof body.nickname === 'string' ? body.nickname.slice(0, 50) : null;
    await env.DB
      .prepare(
        `INSERT INTO catalog (user_id, nickname, saved_count, last_seen)
         VALUES (?1, ?2, 1, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           saved_count = saved_count + 1,
           nickname = COALESCE(?2, nickname),
           last_seen = datetime('now')`
      )
      .bind(userId, nickname)
      .run();
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'method not allowed' }, 405);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS, ...CORS } });
    }

    const requestUrl = new URL(request.url);

    // Player catalog (this worker's own API, not a proxied passthrough).
    if (requestUrl.pathname === '/catalog') {
      return handleCatalog(request, requestUrl, env);
    }
    if (requestUrl.pathname === '/history') {
      return handleHistory(request, requestUrl, env);
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const target = requestUrl.searchParams.get('url');
    if (!target) {
      return new Response('Missing ?url= parameter', { status: 400, headers: CORS_HEADERS });
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response('Invalid ?url= parameter', { status: 400, headers: CORS_HEADERS });
    }

    // Only proxy the PolyTrack API — this worker is not an open proxy.
    if (targetUrl.protocol !== 'https:' || targetUrl.host !== ALLOWED_API_HOST) {
      return new Response('Only https://' + ALLOWED_API_HOST + ' may be proxied', {
        status: 403,
        headers: CORS_HEADERS,
      });
    }

    const apiResponse = await fetch(targetUrl.toString(), {
      headers: { Origin: GAME_ORIGIN },
    });

    const headers = new Headers(apiResponse.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      headers.set(key, value);
    }
    // Cache successful leaderboard responses at the edge for a short time.
    headers.set('Cache-Control', apiResponse.ok ? 'public, max-age=30' : 'no-store');

    return new Response(apiResponse.body, {
      status: apiResponse.status,
      headers,
    });
  },
};
