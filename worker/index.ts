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
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        nickname TEXT,
        car_style TEXT,
        first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    ),
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

/** Official track ids (0.6.3) — kept in sync with PolyStats src/lib/tracks.ts. */
const OFFICIAL_TRACK_IDS: [string, string][] = [
  ['Summer 1', '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038'],
  ['Summer 2', '7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0'],
  ['Summer 3', '148826aa16ffaa23dbc453b32cff05e025ddbce1773fc7733cc13d218926515a'],
  ['Summer 4', '93c7363dfea7fb09ca1d23b72cad5df43a30841d41c8ff25fb544c85bb03c7ae'],
  ['Summer 5', '7603aaeffa1989a649dfaa8e1804bed4481b49df233e377687d0669899566e52'],
  ['Summer 6', 'c117823cf6788e3247b9ee63a0c091c07352bbe352c650a7790dc6718148c2fa'],
  ['Summer 7', 'e4bcaca3a583bb0eb62a700a69d14e89c852f0c5bf740fca76e0519ebdfc9ab1'],
  ['Winter 1', '7239b17057127936907a805b0caa5d8c6f6c97eca9bdabf1a5312dce479629b7'],
  ['Winter 2', '99864b635d1891d22e17eb9267527a07a92c49c0f02893729fa2ded90e3ca0f9'],
  ['Winter 3', 'a5341fe706097cff2a3812a3fc0d87399254557328351ae8e5c882700fc1a196'],
  ['Winter 4', '7d134c939df80c676a258266201beedd3b93572d5603f3ff4339ff8679803715'],
  ['Winter 5', '2fe4bd46b0075cc25fc770ce50adbb68447cf493c999635bb272d231811dd264'],
  ['Desert 1', 'c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34'],
  ['Desert 2', '88647ea04145fbbbb19b55f1590e038fb0378acb2571110f02cb545cc46b0d57'],
  ['Desert 3', '2806030c503abb41a1a26fa9a570888be14296172bb273798ef0ad87a108a2ec'],
  ['Desert 4', '4697ea67b18c3f49b30a3d8884602115536650bc5435c88e3732e64d21a72d33'],
  ['Desert 5', 'e5d084e06db4ab71196fea44efeceb23c8561266a78669c324a38f92581fe2db'],
];

const SNAPSHOT_DEPTH = 50; // top N players per track per run
const API_VERSION = '0.6.3';

/**
 * Cron: snapshot the top of every official leaderboard into D1.
 * Appends a history row only when the #1 time improved (WR history),
 * and upserts every seen player into the users table.
 */
async function snapshotLeaderboards(env: Env): Promise<void> {
  if (!env.DB) return;
  await ensureSchema(env);

  const upsertUser = env.DB.prepare(
    `INSERT INTO users (user_id, nickname, car_style, last_seen)
     VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       nickname = COALESCE(?2, nickname),
       car_style = COALESCE(?3, car_style),
       last_seen = datetime('now')`
  );

  for (const [trackName, trackId] of OFFICIAL_TRACK_IDS) {
    try {
      const res = await fetch(
        `https://vps.kodub.com/v6/leaderboard?version=${API_VERSION}&trackId=${trackId}&skip=0&amount=${SNAPSHOT_DEPTH}&onlyVerified=false`,
        { headers: { Origin: GAME_ORIGIN } }
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        entries?: { userId: string; nickname?: string; carStyle?: string; frames?: number; verifiedState?: number }[];
      };
      const entries = data.entries ?? [];
      if (entries.length === 0) continue;

      const statements = entries.map((e) =>
        upsertUser.bind(e.userId, e.nickname ?? null, e.carStyle ?? null)
      );

      // WR history: record the top verified time when it beats the stored best
      const top = entries[0];
      const best = await env.DB
        .prepare('SELECT MIN(time_ms) AS t FROM wr_history WHERE track_id = ?1')
        .bind(trackId)
        .first<{ t: number | null }>();
      if (top.frames && (best?.t == null || top.frames < best.t)) {
        statements.push(
          env.DB
            .prepare(
              `INSERT OR IGNORE INTO wr_history (track_id, player, time_ms, set_at, recording)
               VALUES (?1, ?2, ?3, datetime('now'), NULL)`
            )
            .bind(trackId, top.nickname ?? 'unknown', top.frames)
        );
      }
      await env.DB.batch(statements);
    } catch (e) {
      // one track failing must not kill the run
      console.error(`snapshot failed for ${trackName}:`, e);
    }
  }
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

  if (request.method === 'PUT') {
    // Upsert a player profile (called when PolyStats users look someone up).
    const origin = request.headers.get('Origin') ?? '';
    if (!WRITE_ORIGINS.has(origin)) {
      return jsonResponse({ error: 'writes from this origin are not allowed' }, 403);
    }
    let body: { userId?: string; nickname?: string; carStyle?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    if (!body.userId || !/^[a-f0-9]{64}$/.test(body.userId)) {
      return jsonResponse({ error: 'userId must be a 64-char hex string' }, 400);
    }
    await ensureSchema(env);
    await env.DB
      .prepare(
        `INSERT INTO users (user_id, nickname, car_style, last_seen)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           nickname = COALESCE(?2, nickname),
           car_style = COALESCE(?3, car_style),
           last_seen = datetime('now')`
      )
      .bind(body.userId, body.nickname ?? null, body.carStyle ?? null)
      .run();
    return jsonResponse({ ok: true });
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
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    ctx.waitUntil(snapshotLeaderboards(env));
  },

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
    if (requestUrl.pathname === '/users') {
      if (request.method !== 'GET') {
        return handleCatalog(request, requestUrl, env); // PUT upsert shares origin checks
      }
      if (!env.DB) return jsonResponse({ error: 'users unavailable: D1 binding missing' }, 503);
      await ensureSchema(env);
      const limit = Math.min(Number(requestUrl.searchParams.get('limit') ?? 50) || 50, 200);
      const search = requestUrl.searchParams.get('q');
      const { results } = search
        ? await env.DB
            .prepare("SELECT user_id, nickname, car_style, last_seen FROM users WHERE nickname LIKE ?1 ORDER BY last_seen DESC LIMIT ?2")
            .bind(`%${search}%`, limit)
            .all()
        : await env.DB
            .prepare('SELECT user_id, nickname, car_style, last_seen FROM users ORDER BY last_seen DESC LIMIT ?1')
            .bind(limit)
            .all();
      return jsonResponse({ users: results });
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
