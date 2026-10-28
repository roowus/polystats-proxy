/**
 * Index coverage tests.
 *
 * Every query below was chosen because it either scanned a whole table or sorted
 * in a temp B-tree at runtime. Table scans are paid for in D1 row reads, which are
 * capped per day, so a missing index turns into a quota outage rather than just a
 * slow page.
 *
 * These tests read the schema and queries out of the worker source instead of
 * starting a database. That keeps them fast and dependency-free in CI, and means a
 * query that changes shape must come back and update its index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'worker', 'index.ts'), 'utf8');

/** Every CREATE INDEX statement in the worker. */
function indexes() {
  return [...source.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/g)].map((m) => ({
    name: m[1],
    table: m[2],
    columns: m[3].replace(/\s+/g, ' ').trim(),
  }));
}

test('results is indexed by user_id, since its primary key leads with track_id', () => {
  // results is keyed (track_id, user_id). The profile page filters on user_id
  // alone, so without this index SQLite cannot use the primary key and scans the
  // whole table on every profile view.
  const idx = indexes().find((i) => i.table === 'results' && i.columns.startsWith('user_id'));
  assert.ok(idx, 'expected an index on results(user_id, ...)');
  assert.match(idx.columns, /^user_id, time_ms/, 'time_ms must follow user_id so ORDER BY is free');
});

test('the profile query really filters by user_id and orders by time_ms', () => {
  const q = /FROM results r WHERE r\.user_id = \?1 ORDER BY r\.time_ms/.test(source);
  assert.ok(q, 'profile query changed shape; re-check idx_results_user');
});

test('users is indexed for the uncapped last_seen listing', () => {
  const idx = indexes().find((i) => i.table === 'users' && /last_seen/.test(i.columns));
  assert.ok(idx, 'expected an index on users(last_seen ...)');
  assert.match(source, /FROM users ORDER BY last_seen DESC LIMIT \?1/, 'the listing query should still match this index');
});

test('the pending-recordings index is created behind a column check', () => {
  // This index caused an outage: `entry_id` is not in the wr_history CREATE TABLE
  // and no ALTER adds it, so creating the index in the main DDL list threw
  // "no such column: entry_id" inside ensureSchema, which gates every route.
  // It must therefore be guarded by a PRAGMA check and must not sit in the DDL
  // array with the other indexes.
  assert.match(
    source,
    /PRAGMA table_info\(wr_history\)/,
    'entry_id index must verify the column exists first'
  );
  assert.match(
    source,
    /name === 'entry_id'/,
    'the guard should check specifically for entry_id'
  );
  assert.match(source, /idx_history_pending ON wr_history\(entry_id\)/, 'index should still be created');
  assert.match(source, /WHERE recording IS NULL AND entry_id IS NOT NULL/, 'and keep its partial predicate');

  // It must not appear as an executable statement in the unguarded DDL array:
  // that array runs before the column check, which is what broke. Match only
  // db.prepare(...) call sites, not the explanatory comment that mentions it.
  const executable = [...source.matchAll(/db\s*\.\s*prepare\(\s*['"`](CREATE INDEX[^'"`]*?)['"`]/g)]
    .map((m) => m[1])
    .filter((sql) => /idx_history_pending/.test(sql));
  for (const sql of executable) {
    // Any occurrence must be the guarded one, which is built with a template or
    // appears after the PRAGMA check in source order.
    const at = source.indexOf(sql);
    const pragmaAt = source.indexOf('PRAGMA table_info(wr_history)');
    assert.ok(
      at > pragmaAt,
      'idx_history_pending must only be created after the PRAGMA column check'
    );
  }
});

test('the per-track MIN query is served by the existing history index', () => {
  // This one looks like a scan but is already covered: idx_history_track is
  // (track_id, time_ms), so MIN(time_ms) for one track is a single index seek.
  const idx = indexes().find((i) => i.table === 'wr_history' && /^track_id, time_ms/.test(i.columns));
  assert.ok(idx, 'idx_history_track(track_id, time_ms) must stay: it covers MIN(time_ms) WHERE track_id = ?');
  assert.match(source, /SELECT MIN\(time_ms\) AS t FROM wr_history WHERE track_id = \?1/);
});

test('no index is defined on a table that the worker does not create', () => {
  const tables = new Set([...source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]));
  // Tables added by ALTER TABLE / migrations.
  tables.add('catalog');
  for (const idx of indexes()) {
    assert.ok(tables.has(idx.table), `index ${idx.name} targets unknown table ${idx.table}`);
  }
});

test('every index has a comment explaining the query it serves', () => {
  // An index with no stated purpose is impossible to remove safely later.
  const lines = source.split('\n');
  for (const idx of indexes()) {
    const at = lines.findIndex((l) => l.includes(`CREATE INDEX IF NOT EXISTS ${idx.name}`));
    assert.ok(at > 0, `${idx.name} not found in source`);
    const context = lines.slice(Math.max(0, at - 8), at).join('\n');
    assert.match(context, /\/\/|--/, `index ${idx.name} should have a comment explaining its query`);
  }
});
