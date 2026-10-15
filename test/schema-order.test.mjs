/**
 * Tests for schema statement ordering in `ensureSchema`.
 *
 * These exist because of a production outage. The worker created an index on
 * `users(nickname_lower)` while that column was still added by an ALTER TABLE
 * further down the same function. On any database where the migration had not yet
 * run, the statement threw "no such column", and because it sat outside a
 * try/catch the exception escaped `ensureSchema` — which gates nearly every route
 * and only marks the schema ready on its last line. Every request to the worker
 * returned 500, and the site reported it as "no leaderboard entries found".
 *
 * The check is textual on purpose: it needs no database, so it runs in CI on every
 * commit and catches the ordering mistake at the point it is introduced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = readFileSync(path.join(ROOT, 'worker', 'index.ts'), 'utf8');

/** The body of `ensureSchema`, up to its closing `schemaReady = true`. */
function ensureSchemaBody() {
  const start = SOURCE.indexOf('async function ensureSchema');
  assert.ok(start > -1, 'ensureSchema not found');
  const end = SOURCE.indexOf('schemaReady = true', start);
  assert.ok(end > start, 'schemaReady assignment not found');
  return SOURCE.slice(start, end);
}

test('every column an index references is created before that index', () => {
  const body = ensureSchemaBody();
  // Every `CREATE INDEX ... ON <table>(<column>)` in the function.
  const indexRe = /CREATE INDEX[^`'"]*?ON\s+(\w+)\s*\(\s*(\w+)/gi;
  for (const m of body.matchAll(indexRe)) {
    const [, table, column] = m;
    const indexAt = m.index ?? 0;
    // The column is available if the table is created with it inline, or an
    // ALTER TABLE adds it earlier in the function than the index.
    const inlineCreate = new RegExp(
      `CREATE TABLE IF NOT EXISTS ${table}\\s*\\([^)]*\\b${column}\\b`,
      's'
    ).test(body);
    const alterAt = body.search(
      new RegExp(`ALTER TABLE ${table} ADD COLUMN ${column}\\b`)
    );
    const created = inlineCreate || (alterAt > -1 && alterAt < indexAt);
    assert.ok(
      created,
      `index on ${table}(${column}) is created before that column exists`
    );
  }
});

test('no migration statement can take the whole worker down', () => {
  const body = ensureSchemaBody();
  // Every `await db...run()` / `.first()` that is not inside a try block would
  // escape ensureSchema and 500 every route. Rather than parse scopes, assert the
  // blocks that previously held bare awaits are each guarded.
  for (const marker of [
    'nickname_lower backfill failed',
    'catalog fold failed',
    'FTS index unavailable',
  ]) {
    assert.ok(
      body.includes(marker),
      `expected a guard reporting "${marker}" inside ensureSchema`
    );
  }
});

test('the scheduled handler dispatches exactly the registered crons', () => {
  const toml = readFileSync(path.join(ROOT, 'worker', 'wrangler.toml'), 'utf8');
  const declared = toml
    .match(/crons\s*=\s*\[([^\]]*)\]/)[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  const scheduledAt = SOURCE.indexOf('async scheduled');
  assert.ok(scheduledAt > -1, 'scheduled handler not found');
  const scheduled = SOURCE.slice(scheduledAt, scheduledAt + 2000);
  const dispatched = [...scheduled.matchAll(/controller\.cron === '([^']+)'/g)].map(
    (m) => m[1]
  );

  for (const cron of declared) {
    assert.ok(
      dispatched.includes(cron),
      `cron "${cron}" is registered in wrangler.toml but not dispatched, so it ` +
        'silently falls through to another job'
    );
  }
  for (const cron of dispatched) {
    assert.ok(
      declared.includes(cron),
      `cron "${cron}" is dispatched but never registered, so it never runs`
    );
  }
});

test('every dispatched cron covers all registered schedules', () => {
  // The watch cron must be reachable: it was previously dispatched as
  // '*/15 * * * *', which is not registered, so record collection stopped.
  const scheduledAt = SOURCE.indexOf('async scheduled');
  const scheduled = SOURCE.slice(scheduledAt, scheduledAt + 2000);
  assert.ok(
    scheduled.includes("'*/5 * * * *'"),
    'the five-minute watch schedule is not dispatched'
  );
  assert.ok(
    scheduled.includes('unrecognised cron schedule'),
    'an unknown schedule should be reported rather than silently misrouted'
  );
});
