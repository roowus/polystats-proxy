/**
 * The write path must never trust request bodies.
 *
 * A client used to PUT { nickname, carStyle } and have it written straight into
 * `users`. The only guard was the Origin header, which any script can set, so any
 * caller could overwrite any player's record.
 *
 * Those values must now only ever come from a PolyTrack API response. These tests
 * read the worker source, so a future change that starts writing request-supplied
 * fields again fails here instead of silently reopening the hole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'worker', 'index.ts'), 'utf8');

/** The body of the `if (request.method === 'PUT')` branch. */
function putHandler() {
  const start = source.indexOf("request.method === 'PUT'");
  assert.ok(start > 0, 'PUT handler not found');
  // Walk braces so nested blocks do not truncate the body.
  let depth = 0;
  let seen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
      seen = true;
    } else if (source[i] === '}') {
      depth--;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced PUT handler');
}

test('the client write path takes only a user_id', () => {
  const body = putHandler();
  // The parsed body type must not declare writable profile fields.
  assert.ok(
    !/nickname\s*\??:/.test(body),
    'PUT must not accept a nickname from the client'
  );
  assert.ok(
    !/carStyle\s*\??:/.test(body),
    'PUT must not accept a carStyle from the client'
  );
  assert.ok(
    !/countryCode\s*\??:/.test(body),
    'PUT must not accept a countryCode from the client'
  );
  assert.match(body, /userId\s*\??:/, 'PUT should still take a userId');
});

test('the client write path queues instead of writing profile data', () => {
  const body = putHandler();
  assert.match(body, /INSERT OR IGNORE INTO refresh_queue/, 'PUT should enqueue a refresh');
  assert.ok(
    !/userUpsertStatements\s*\(/.test(body),
    'PUT must not write profile fields directly'
  );
});

test('the queue worker sources values from the API, never the request', () => {
  const start = source.indexOf('async function processRefreshQueue');
  const end = source.indexOf('async function resolveUserFromLeaderboards');
  assert.ok(start > 0 && end > start, 'refresh functions not found');
  const fn = source.slice(start, end);
  // Values written must come from the resolver, which calls the API.
  assert.match(fn, /resolveUserFromLeaderboards\(userId\)/, 'values must come from the API resolver');
  assert.match(fn, /found\.nickname/, 'nickname should come from the resolved API data');
  assert.match(fn, /found\.carStyle/, 'carStyle should come from the resolved API data');
});

test('a refresh cannot loop forever on an unknown id', () => {
  const start = source.indexOf('async function processRefreshQueue');
  const end = source.indexOf('async function resolveUserFromLeaderboards');
  const fn = source.slice(start, end);
  assert.match(fn, /attempts/, 'retries should be counted');
  assert.match(fn, /DELETE FROM refresh_queue/, 'rows should be removed once done or abandoned');
});

test('COUNT(*) is not run on every job invocation', () => {
  // recordCounts scans five tables (~26k reads). It must be gated on rows
  // actually changing, not called unconditionally after every run.
  const idx = source.indexOf('if (rowsChanged > 0) await recordCounts');
  assert.ok(idx > 0, 'recordCounts must be guarded by rowsChanged');
  const surrounding = source.slice(Math.max(0, idx - 900), idx);
  assert.match(surrounding, /rowsChanged/, 'the gate should use the job return value');
});
