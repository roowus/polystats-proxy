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
  /** Optional shared secret for /run (external schedulers). Set via `wrangler secret put`. */
  SCHEDULE_TOKEN?: string;
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

/** WR watch: cheap — only writes when a record actually falls. */
async function wrWatch(db: D1Database): Promise<void> {
  await ensureSchema(db);
  let broken = 0;
  for (const [, trackId] of ALL_TRACK_IDS) {
    try {
      const res = await fetch(
        `https://vps.kodub.com/v6/leaderboard?version=${API_VERSION}&trackId=${trackId}&skip=0&amount=1&onlyVerified=true`,
        { headers: { Origin: GAME_ORIGIN } }
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { entries?: { userId: string; nickname?: string; frames?: number }[] };
      const top = data.entries?.[0];
      if (!top?.frames) continue;
      const best = await db.prepare('SELECT MIN(time_ms) AS t FROM wr_history WHERE track_id = ?1').bind(trackId).first<{ t: number | null }>();
      if (best?.t == null || top.frames < best.t) {
        await db
          .prepare(
            `INSERT INTO wr_history (track_id, player, time_ms, set_at, recording)
             VALUES (?1, ?2, ?3, datetime('now'), NULL)
             ON CONFLICT(track_id, player, time_ms, set_at) DO NOTHING`
          )
          .bind(trackId, top.nickname ?? 'unknown', top.frames)
          .run();
        broken += 1;
      }
    } catch (e) {
      console.error('WR watch failed for', trackId, e);
    }
  }
  await db
    .prepare("INSERT INTO meta (key, value) VALUES ('last_wr_watch', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1")
    .bind(new Date().toISOString())
    .run();
  if (broken > 0) console.log(`WR watch: ${broken} record(s) broken`);
}

/** Full top-50 snapshot of every track + TOTW archive. */
async function runSnapshot(db: D1Database): Promise<void> {
  await snapshotLeaderboards(db);
  await db
    .prepare("INSERT INTO meta (key, value) VALUES ('last_fresh_run', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1")
    .bind(new Date().toISOString())
    .run();
}

/** Daily backfill: deep-crawl the long tail. */
async function runBackfill(db: D1Database): Promise<void> {
  await ensureSchema(db);
  const cursor = await getCursor(db);
  const seen = await backfillTracks(db, cursor);
  await db
    .prepare("INSERT INTO meta (key, value) VALUES ('last_backfill_run', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1")
    .bind(new Date().toISOString())
    .run();
  console.log(`backfill pass done: cursor ${cursor}, ${seen} results seen`);
}

/**
 * Backfill tick: exactly one leaderboard page (50 players) per call,
 * cycling through tracks and depth. Designed for a 5-minute external ping:
 * 50 players x 288 ticks/day = ~14.4k players/day of steady coverage.
 */
async function backfillTick(db: D1Database): Promise<{ trackName: string; page: number; players: number }> {
  await ensureSchema(db);
  const cursor = await getCursor(db);
  const trackIdx = cursor % ALL_TRACK_IDS.length;
  const page = Math.floor(cursor / ALL_TRACK_IDS.length) % BACKFILL_PAGES;
  const [trackName, trackId] = ALL_TRACK_IDS[trackIdx];

  const res = await fetch(
    `https://vps.kodub.com/v6/leaderboard?version=${API_VERSION}&trackId=${trackId}&skip=${page * SNAPSHOT_DEPTH}&amount=${SNAPSHOT_DEPTH}&onlyVerified=false`,
    { headers: { Origin: GAME_ORIGIN } }
  );
  if (!res.ok) throw new Error(`leaderboard fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    entries?: { userId: string; nickname?: string; carStyle?: string; frames?: number; verifiedState?: number }[];
  };
  const entries = data.entries ?? [];
  const upsertUser = db.prepare(
    `INSERT INTO users (user_id, nickname, car_style, last_seen)
     VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET last_seen = datetime('now')`
  );
  const upsertResult = db.prepare(
    `INSERT INTO results (track_id, user_id, time_ms, verified)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(track_id, user_id) DO UPDATE SET
       time_ms = MIN(time_ms, excluded.time_ms),
       verified = MAX(verified, excluded.verified),
       updated_at = datetime('now')`
  );
  const stmts = entries.map((e) => upsertResult.bind(trackId, e.userId, e.frames ?? 0, e.verifiedState === 1 ? 1 : 0));
  const uniq = new Map(entries.map((e) => [e.userId, e]));
  for (const e of uniq.values()) {
    stmts.push(upsertUser.bind(e.userId, e.nickname ?? null, e.carStyle ?? null));
  }
  if (stmts.length > 0) await db.batch(stmts);
  await setCursor(db, cursor + 1);
  return { trackName, page, players: entries.length };
}

/**
 * HTTP-triggered jobs for external schedulers (GitHub Actions, cron-job.org…).
 * Guarded by SCHEDULE_TOKEN and a minimum-interval so double-fires and
 * strangers can't burn the D1 write budget.
 */
async function handleRun(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.DB) return jsonResponse({ error: 'jobs unavailable: D1 binding missing' }, 503);
  const db = env.DB;
  const job = url.searchParams.get('job');
  if (job !== 'watch' && job !== 'snapshot' && job !== 'backfill' && job !== 'tick') {
    return jsonResponse({ error: "job must be 'watch' | 'snapshot' | 'backfill' | 'tick'" }, 400);
  }
  if (env.SCHEDULE_TOKEN) {
    const token = url.searchParams.get('token') ?? request.headers.get('X-Schedule-Token');
    if (token !== env.SCHEDULE_TOKEN) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
  }
  // Min-interval guard: skip if this job ran recently (idempotent + abuse-proof).
  const intervals: Record<string, number> = { watch: 10 * 60 * 1000, snapshot: 5 * 3600 * 1000, backfill: 7 * 3600 * 1000, tick: 4 * 60 * 1000 };
  const key = `last_run_${job}`;
  const last = await db.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first<{ value: string }>();
  if (last?.value && Date.now() - new Date(last.value).getTime() < intervals[job]) {
    return jsonResponse({ ok: true, skipped: true, reason: 'ran recently', last_run: last.value });
  }

  try {
    if (job === 'watch') await wrWatch(db);
    else if (job === 'snapshot') await runSnapshot(db);
    else await runBackfill(db);
  } catch (e) {
    return jsonResponse({ error: String(e), stack: e instanceof Error ? e.stack : null }, 500);
  }
  await db
    .prepare("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2")
    .bind(key, new Date().toISOString())
    .run();
  return jsonResponse({ ok: true, job });
}

/** Upsert a user, capturing nickname/color history on change. */
function userUpsertStatements(
  db: D1Database,
  userId: string,
  nickname: string | null,
  carStyle: string | null,
  countryCode?: string | null
) {
  return [
    db
      .prepare(
        `INSERT INTO users (user_id, nickname, car_style, country_code, last_seen)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           nickname = COALESCE(?2, nickname),
           car_style = COALESCE(?3, car_style),
           country_code = COALESCE(?4, country_code),
           last_seen = datetime('now')`
      )
      .bind(userId, nickname, carStyle, countryCode ?? null),
    // name history: append when this nickname isn't already recorded
    db
      .prepare(
        `INSERT INTO user_names (user_id, nickname, last_seen)
         SELECT ?1, ?2, datetime('now')
         WHERE ?2 IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM user_names WHERE user_id = ?1 AND nickname = ?2
         )`
      )
      .bind(userId, nickname),
    db
      .prepare(
        `UPDATE user_names SET last_seen = datetime('now') WHERE user_id = ?1 AND nickname = ?2`
      )
      .bind(userId, nickname),
    // car style history: same pattern
    db
      .prepare(
        `INSERT INTO user_styles (user_id, car_style, last_seen)
         SELECT ?1, ?2, datetime('now')
         WHERE ?2 IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM user_styles WHERE user_id = ?1 AND car_style = ?2
         )`
      )
      .bind(userId, carStyle),
    db
      .prepare(
        `UPDATE user_styles SET last_seen = datetime('now') WHERE user_id = ?1 AND car_style = ?2`
      )
      .bind(userId, carStyle),
  ];
}

/** Create the catalog table on first use (zero-touch migrations). */
let schemaReady = false;
async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  // D1 batches reject some DDL; run each statement individually (all idempotent).
  const ddl: D1PreparedStatement[] = [
    db.prepare(`CREATE TABLE IF NOT EXISTS catalog (
      user_id TEXT PRIMARY KEY,
      nickname TEXT,
      saved_count INTEGER NOT NULL DEFAULT 1,
      last_seen TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS wr_history (
      track_id TEXT NOT NULL,
      player TEXT NOT NULL,
      time_ms INTEGER NOT NULL,
      set_at TEXT NOT NULL,
      recording TEXT,
      UNIQUE(track_id, player, time_ms, set_at)
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_history_track ON wr_history(track_id, time_ms)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      nickname TEXT,
      car_style TEXT,
      country_code TEXT,
      save_count INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS results (
      track_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      time_ms INTEGER NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (track_id, user_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_names (
      user_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, nickname)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_styles (
      user_id TEXT NOT NULL,
      car_style TEXT NOT NULL,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, car_style)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS snapshots (
      track_id TEXT NOT NULL,
      snap_date TEXT NOT NULL,
      position INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      time_ms INTEGER NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (track_id, snap_date, position)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS totw_archive (
      track_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      author TEXT,
      environment INTEGER,
      end_time TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_snapshots_user ON snapshots(user_id)'),
  ];
  for (let i = 0; i < ddl.length; i++) {
    try {
      await ddl[i].run();
    } catch (e) {
      const msg = String(e);
      if (/already exists/i.test(msg)) continue;
      throw new Error(`ensureSchema statement ${i} failed: ${msg}`);
    }
  }
  // One-time fold: legacy catalog rows -> users.save_count, then drop the old table.
  const folded = await db.prepare("SELECT value FROM meta WHERE key = 'catalog_folded'").first<{ value: string }>();
  if (!folded) {
    await db
      .prepare(
        `INSERT INTO users (user_id, save_count)
         SELECT user_id, saved_count FROM catalog WHERE true
         ON CONFLICT(user_id) DO UPDATE SET save_count = MAX(users.save_count, excluded.save_count)`
      )
      .run();
    await db.prepare('DROP TABLE IF EXISTS catalog').run();
    await db
      .prepare("INSERT INTO meta (key, value) VALUES ('catalog_folded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
      .run();
  }
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
  const db = env.DB;
  if (!db) {
    return jsonResponse({ error: 'history unavailable: D1 binding missing' }, 503);
  }
  await ensureSchema(db);

  if (request.method === 'GET') {
    const trackId = url.searchParams.get('trackId');
    if (trackId) {
      const { results } = await db
        .prepare('SELECT track_id, player, time_ms, set_at, recording FROM wr_history WHERE track_id = ?1 ORDER BY set_at ASC')
        .bind(trackId)
        .all<HistoryRow>();
      return jsonResponse({ history: results });
    }
    const { results } = await db
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
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'history unavailable: D1 binding missing' }, 503);
    let body: { rows?: { trackId?: string; player?: string; timeMs?: number; ts?: string; recording?: string }[] };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    const rows = (body.rows ?? []).filter(
      (r): r is { trackId: string; player: string; timeMs: number; ts: string; recording?: string } =>
        r.trackId !== undefined &&
        /^[a-f0-9]{64}$/.test(r.trackId) &&
        typeof r.player === 'string' &&
        typeof r.timeMs === 'number' &&
        typeof r.ts === 'string'
    );
    if (rows.length === 0) return jsonResponse({ error: 'no valid rows' }, 400);
    const stmt = db.prepare(
      `INSERT INTO wr_history (track_id, player, time_ms, set_at, recording)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    );
    await db.batch(rows.map((r) => stmt.bind(r.trackId, r.player.slice(0, 80), Math.round(r.timeMs), r.ts, r.recording ?? null)));
    return jsonResponse({ ok: true, ingested: rows.length });
  }

  return jsonResponse({ error: 'method not allowed' }, 405);
}

/** Official track ids (0.6.3) — kept in sync with PolyStats src/lib/tracks.ts. */
const ALL_TRACK_IDS: [string, string][] = [
  // --- community tracks (featured in-game) ---
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
  ['Amberbound', '4058e3616fbd79b848e70037adde4f12b4413011050aaf1c9d875cdbe2e33d68'],
  ['Star Bound', '76e1920a3ca015033a0b21156848def2c248c95d97ccf4aab2312a0302beefe0'],
  ['Arx Lucida', '520c4f511821ced30b99bceafbb02e6b7531e867126b0756e68d5e157691ef2f'],
  ['Koselig', '315c9e95c567cce4feca78f5ad6e8d08d0a22dac0d56061af567b43eea3d4fa8'],
  ['Sky Bound', 'a8913b96daceb5b615fe45aad2bb104e04eb7db140242934657111e1d1f55b89'],
  ['ShardMir', '66f43b2d2a17f3cee05a127040ca409795058510bd3d1ac7eee224512ec532f5'],
  ['Sunken Glyphs', 'b3889905b6df31cbe302e58e975988385607771605bf6e8e8e8e31b3d2dc8aa1'],
  ['Grimspyre', '3cd94552b12fb3a8ac45ca3a5e21a882b71b31c788989b396ab382afc69414ac'],
  ['Magenta Mines', '3125a5f98c3b43cf1e2604e25e8504bffd714ea5843200fa8ddf0b4c58842f16'],
  ['Cruising Altitude', 'a2137c20c03ad1848098b47f70417cc0b0bf169010c825dc6fb82f37066808a0'],
  ['Termite Terror', 'd03b9f7c10c95f40eed389458be51bdf2437febd5673d028da134e59e503c10b'],
  ['Lost at sea', 'a1f41dc9e884d5d4b1b6025158d70f0934dc4d892076e6c4b32dc3f3846b882e'],
  ['Frosted Fjords', 'b430aad5e481caa4588e30f46352b876b62f1ba0cf7730a15efd026c91a8f32e'],
  ['Levitation', '95d8f7cbe11053dbdfaeeb2f3c3d8f53f0d45fb6abeb411a74949a4cf52f427f'],
  ['Frozen Ramparts', '409f26b9faf55bd0ad748177bf85ebdcfc0ddd572190e7f464f38b4a60587b7e'],
  ['Tangled Cliffs', 'c1a2c5aef1029d7bbf946f08cd087dd25bad6e019a41694a48a0024c27627dc8'],
  ['Sludge Pipe Circuit', '9e53d03f4efe86834c49ce202b528d769d9aa7a6e17732d0fc56440463956a1b'],
  ['Zealot', 'b77ec520a40c4b38d3d7d653b747b1f8627c98709096568db22cd1bfec534ba6'],
  ['Shrouded Oasis', '9f827673c4132828009237a03e12ead73eae87504b4708a79c6cc0858212262d'],
  ['Cogware', '9acd9aef650c4ccc41bb01f72ed44dfaa13f2e4404d2e3466f09cc1adcd9a9c0'],
  ['Land of the Rising Sun', '62d9989187e4508f7866e7b30aa187ddbee2595df21ff5988d7fec3589f9048d'],
  ['Midas Metropolis', 'b36162623435dc90a54f57590d2baa9f2d67a51cb12c393531f4b6d5e5528ebf'],
  ['Frozen In Time', '74ae56c0f278a19f3b69f3903198c7b9de09981133205856b53bf6bdf8db4211'],
  ['Winterfell', '9f4597449906aa0c2baf9a4737406385c829533e64e9e972b25b4189f4593a54'],
  ['Launch Control', '28b658c7d10eb8b5de6f465e034e87e40f70b37e4534d8c37d1f2af06b5a36d7'],
  ['Ghost City', '18b69f54f119cfb2867abded9a1574f0799a750ef94aa744d9ec8ef6b4d565ae'],
  ['MOS ESPA', '5ea46b3ae268a0196dcc59dabe88926400b56e29814658bfed06a284f837cefd'],
  ['Joenail Jones', 'ab8e1c13ddf394102be1cb04adcff8411127f1e7140a216d27a94fc19b7d0428'],
  ['Anubis', '86335d78d1a06d3dc81d80f84b8ac2e8f6359e9a206826e2c36f7d3f4351bea4'],
  ['Natsujō', 'a510bbd3341f2992a12db8a3780cb8943b6087538345d58d16602d6129742df0'],
  ['Arabica', '8cf99166f12cbb56a9df4e022a0e9b8c78973adb929dbf1e265ebb9f99f01163'],
  ["Hyperion's Sanctuary", '33d99aad2ad5cef45b1d3afb8735c5229cfd98ac7cc24916e0da7283f7a545ce'],
  ['Winter Hollow', '5c00f2c90bcf8230183484225d1a417e45b0ad310379acfafd4c8f1dc7345dd7'],
  ['Clay temples', '009fad7fcc215022c6b2dbb2b6de622f07cd88d4930b8e2b6a6b74c1f5de9e44'],
  ['Las Calles', '1ad53694ee3e96aea27afa7b64d5c29d115de88a17b69cf3fe3f5609c52b040b'],
  ['DESERT STALLION', '2ed125037366052871fbb97da6e1bda49cfeb471f6b9c8fa799d520bdb3683e2'],
  ['Last Remnant', 'f79b1d863d50f9e3b4489988698065c6d775ff3ec90bf91085bad05ad5ec8316'],
  ['lu muvimento', '27429a1d1bf05770851e3919af70f47c6cd7a269c67032b084fb4345f6c271ce'],
  ['90*RESET', 'f5c327cf09b90e4de8c3c1f9c910dbb7988cf15485d2e4beec3cc03aef408c5c'],
  ['Opal Palace Repolished', '7451c2128cb96bc28195cf0ca0f83a46c3b55d78d434232d9de085dd1cf0ab36'],
  ['Sandline Ultimatum', '089f2aebcfe4f24d8dda3a8a630172d2bd13793e78c5247adfaa760743a377e1'],
  ['Malformations', '5e40f730509204c77e9c610839ed43addddbe0f8aa007168447f7fde38583905'],
  ['Snow Park', '191737cc4d1b74949e992d99371e5c7f5fc446a716af571c6e5449b23e9f4558'],
  ['concrete jungle', '39bd3fa6c3c769b298c219aee7561af35a6d856bfee14b46b0b48499e7a57ed5'],
];

const SNAPSHOT_DEPTH = 50; // top N players per track per run (fresh data)
const BACKFILL_TRACKS_PER_RUN = 6; // rotating window: full sweep every ~3 runs
const BACKFILL_PAGES = 15; // pages of 50 -> 750 extra players per backfilled track
const API_VERSION = '0.6.3';

async function getCursor(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'backfill_cursor'").first<{ value: string }>();
  return row ? Number(row.value) ?? 0 : 0;
}

async function setCursor(db: D1Database, value: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('backfill_cursor', ?1)
       ON CONFLICT(key) DO UPDATE SET value = ?1`
    )
    .bind(String(value))
    .run();
}

/**
 * Deep-crawl a rotating window of tracks, paging deep into their leaderboards.
 * Fills in the long tail of players beyond the top 50: every result is stored
 * (best time per user/track) and every player is upserted into users.
 */
async function backfillTracks(db: D1Database, cursor: number): Promise<number> {
  const tracks = ALL_TRACK_IDS;
  const window: [string, string][] = [];
  for (let i = 0; i < Math.min(BACKFILL_TRACKS_PER_RUN, tracks.length); i++) {
    window.push(tracks[(cursor + i) % tracks.length]);
  }

  const upsertUser = db.prepare(
    `INSERT INTO users (user_id, nickname, car_style, last_seen)
     VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET last_seen = datetime('now')`
  );
  const upsertResult = db.prepare(
    `INSERT INTO results (track_id, user_id, time_ms, verified)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(track_id, user_id) DO UPDATE SET
       time_ms = MIN(time_ms, excluded.time_ms),
       verified = MAX(verified, excluded.verified),
       updated_at = datetime('now')`
  );

  let seen = 0;
  for (const [, trackId] of window) {
    for (let page = 1; page <= BACKFILL_PAGES; page++) {
      try {
        const res = await fetch(
          `https://vps.kodub.com/v6/leaderboard?version=${API_VERSION}&trackId=${trackId}&skip=${page * SNAPSHOT_DEPTH}&amount=${SNAPSHOT_DEPTH}&onlyVerified=false`,
          { headers: { Origin: GAME_ORIGIN } }
        );
        if (!res.ok) break;
        const data = (await res.json()) as {
          entries?: { userId: string; nickname?: string; carStyle?: string; frames?: number; verifiedState?: number }[];
        };
        const entries = data.entries ?? [];
        if (entries.length === 0) break; // ran past the end of this board
        const stmts = entries.map((e) => {
          seen += 1;
          return upsertResult.bind(trackId, e.userId, e.frames ?? 0, e.verifiedState === 1 ? 1 : 0);
        });
        // one user row per entry, deduped in-memory per page
        const uniq = new Map(entries.map((e) => [e.userId, e]));
        for (const e of uniq.values()) {
          stmts.push(upsertUser.bind(e.userId, e.nickname ?? null, e.carStyle ?? null));
        }
        await db.batch(stmts);
      } catch (e) {
        console.error(`backfill failed for ${trackId} page ${page}:`, e);
        break;
      }
    }
  }
  await setCursor(db, (cursor + BACKFILL_TRACKS_PER_RUN) % tracks.length);
  return seen;
}

/**
 * Cron: snapshot the top of every official leaderboard into D1.
 * Appends a history row only when the #1 time improved (WR history),
 * and upserts every seen player into the users table.
 */
async function snapshotLeaderboards(db: D1Database): Promise<void> {
  await ensureSchema(db);

  // Archive the current Track of the Week (metadata + its top 50)
  try {
    const totwRes = await fetch(`https://vps.kodub.com/v6/trackOfTheWeek?version=${API_VERSION}`, {
      headers: { Origin: GAME_ORIGIN },
    });
    if (totwRes.ok) {
      const totw = (await totwRes.json()) as {
        current?: { trackId: string; name: string; author?: string; environment?: number; endTime?: string };
      };
      if (totw.current?.trackId) {
        const c = totw.current;
        await db
          .prepare(
            `INSERT INTO totw_archive (track_id, name, author, environment, end_time)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(track_id) DO UPDATE SET name = ?2, author = ?3, end_time = ?5`
          )
          .bind(c.trackId, c.name, c.author ?? null, c.environment ?? null, c.endTime ?? null)
          .run();
        const totwBoard = await fetch(
          `https://vps.kodub.com/v6/leaderboard?version=${API_VERSION}&trackId=${c.trackId}&skip=0&amount=${SNAPSHOT_DEPTH}&onlyVerified=false`,
          { headers: { Origin: GAME_ORIGIN } }
        );
        if (totwBoard.ok) {
          const board = (await totwBoard.json()) as {
            entries?: { userId: string; nickname?: string; carStyle?: string; frames?: number; verifiedState?: number }[];
          };
          const snapDate = new Date().toISOString().slice(0, 10);
          const stmts: D1PreparedStatement[] = [];
          (board.entries ?? []).forEach((e, i) => {
            stmts.push(...userUpsertStatements(db, e.userId, e.nickname ?? null, e.carStyle ?? null, null));
            stmts.push(
              db
                .prepare(
                  `INSERT INTO snapshots (track_id, snap_date, position, user_id, time_ms, verified)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                   ON CONFLICT(track_id, snap_date, position) DO UPDATE SET
                     user_id = excluded.user_id, time_ms = excluded.time_ms, verified = excluded.verified`
                )
                .bind(c.trackId, snapDate, i + 1, e.userId, e.frames ?? 0, e.verifiedState === 1 ? 1 : 0)
            );
          });
          if (stmts.length > 0) await db.batch(stmts);
        }
      }
    }
  } catch (e) {
    console.error('TOTW archive failed:', e);
  }

  for (const [trackName, trackId] of ALL_TRACK_IDS) {
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

      const statements: D1PreparedStatement[] = [];
      const snapDate = new Date().toISOString().slice(0, 10);
      entries.forEach((e, i) => {
        statements.push(...userUpsertStatements(db, e.userId, e.nickname ?? null, e.carStyle ?? null, null));
        statements.push(
          db
            .prepare(
              `INSERT INTO snapshots (track_id, snap_date, position, user_id, time_ms, verified)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT(track_id, snap_date, position) DO UPDATE SET
                 user_id = excluded.user_id, time_ms = excluded.time_ms, verified = excluded.verified`
            )
            .bind(trackId, snapDate, i + 1, e.userId, e.frames ?? 0, e.verifiedState === 1 ? 1 : 0)
        );
      });

      // WR history: record the top verified time when it beats the stored best
      const top = entries[0];
      const best = await db
        .prepare('SELECT MIN(time_ms) AS t FROM wr_history WHERE track_id = ?1')
        .bind(trackId)
        .first<{ t: number | null }>();
      if (top.frames && (best?.t == null || top.frames < best.t)) {
        statements.push(
          db
            .prepare(
              `INSERT INTO wr_history (track_id, player, time_ms, set_at, recording)
               VALUES (?1, ?2, ?3, datetime('now'), NULL)
               ON CONFLICT(track_id, player, time_ms, set_at) DO NOTHING`
            )
            .bind(trackId, top.nickname ?? 'unknown', top.frames)
        );
      }
      await db.batch(statements);
    } catch (e) {
      // one track failing must not kill the run
      console.error(`snapshot failed for ${trackName}:`, e);
    }
  }
}

/** Player catalog endpoints (backed by D1; 503 when the binding is absent). */
async function handleCatalog(request: Request, url: URL, env: Env): Promise<Response> {
  const db = env.DB;
  if (!db) {
    return jsonResponse({ error: 'catalog unavailable: D1 binding missing' }, 503);
  }

  await ensureSchema(db);

  if (request.method === 'GET') {
    await ensureSchema(db);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 100);
    const { results } = await db
      .prepare('SELECT user_id, nickname, save_count AS saved_count, last_seen FROM users WHERE save_count > 0 ORDER BY save_count DESC, last_seen DESC LIMIT ?')
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
    let body: { userId?: string; nickname?: string; carStyle?: string; countryCode?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }
    if (!body.userId || !/^[a-f0-9]{64}$/.test(body.userId)) {
      return jsonResponse({ error: 'userId must be a 64-char hex string' }, 400);
    }
    await ensureSchema(db);
    await db.batch(userUpsertStatements(db, body.userId, body.nickname ?? null, body.carStyle ?? null, body.countryCode ?? null));
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
    await db
      .prepare('UPDATE users SET save_count = 0 WHERE user_id = ?1')
      .bind(userId)
      .run();
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
    await db
      .prepare(
        `INSERT INTO users (user_id, nickname, save_count, last_seen)
         VALUES (?1, ?2, 1, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           save_count = save_count + 1,
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
  async scheduled(controller: { cron: string }, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    ctx.waitUntil(
      (async () => {
        const db = env.DB;
        if (!db) return;
        await ensureSchema(db);
        if (controller.cron === '*/15 * * * *') {
          await wrWatch(db);
        } else if (controller.cron === '0 12 * * *' || controller.cron === '0 18 * * *') {
          await runBackfill(db);
        } else {
          await runSnapshot(db);
        }
      })()
    );
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
    if (requestUrl.pathname === '/users/profile') {
      if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
      if (!env.DB) return jsonResponse({ error: 'users unavailable: D1 binding missing' }, 503);
      const db = env.DB;
      await ensureSchema(db);
      const userId = requestUrl.searchParams.get('userId');
      if (!userId || !/^[a-f0-9]{64}$/.test(userId)) {
        return jsonResponse({ error: 'userId must be 64-char hex' }, 400);
      }
      const [user, names, styles, pbs] = await Promise.all([
        db.prepare('SELECT * FROM users WHERE user_id = ?1').bind(userId).first(),
        db.prepare('SELECT nickname, first_seen, last_seen FROM user_names WHERE user_id = ?1 ORDER BY first_seen ASC').bind(userId).all(),
        db.prepare('SELECT car_style, first_seen, last_seen FROM user_styles WHERE user_id = ?1 ORDER BY first_seen ASC').bind(userId).all(),
        db.prepare('SELECT r.track_id, r.time_ms, r.verified, r.updated_at FROM results r WHERE r.user_id = ?1 ORDER BY r.time_ms ASC').bind(userId).all(),
      ]);
      return jsonResponse({ user, names: names.results, styles: styles.results, personal_bests: pbs.results });
    }

    if (requestUrl.pathname === '/run') {
      return handleRun(request, requestUrl, env);
    }

    if (requestUrl.pathname === '/status') {
      if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);
      if (!env.DB) return jsonResponse({ error: 'status unavailable: D1 binding missing' }, 503);
      const { results } = await env.DB.prepare('SELECT key, value FROM meta').all<{ key: string; value: string }>();
      const meta = Object.fromEntries(results.map((r) => [r.key, r.value]));
      return jsonResponse({ version: 3, last_fresh_run: meta.last_fresh_run ?? null, last_backfill_run: meta.last_backfill_run ?? null, last_wr_watch: meta.last_wr_watch ?? null });
    }

    if (requestUrl.pathname === '/users') {
      if (request.method !== 'GET') {
        return handleCatalog(request, requestUrl, env); // PUT upsert shares origin checks
      }
      if (!env.DB) return jsonResponse({ error: 'users unavailable: D1 binding missing' }, 503);
      const db = env.DB;
      await ensureSchema(db);
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
