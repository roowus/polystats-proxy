/**
 * Tests for the FTS MATCH builder.
 *
 * FTS5 has its own query syntax where quotes, `*`, and AND/OR/NOT are operators,
 * and a malformed expression throws instead of returning no rows. This function
 * receives raw user input, so every case must produce a valid expression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFtsQuery } from '../worker/index.ts';

test('builds a quoted prefix term', () => {
  assert.equal(buildFtsQuery('mons'), '"mons"*');
});

test('lowercases', () => {
  assert.equal(buildFtsQuery('MonStrosity'), '"monstrosity"*');
});

test('joins multiple words, requiring all of them', () => {
  assert.equal(buildFtsQuery('mon ster'), '"mon"* "ster"*');
});

test('collapses extra whitespace', () => {
  assert.equal(buildFtsQuery('  mon   ster  '), '"mon"* "ster"*');
});

test('escapes embedded quotes by doubling them', () => {
  assert.equal(buildFtsQuery('a"b'), '"a""b"*');
});

test('quotes FTS operators so they are searched for literally', () => {
  // Unquoted these are operators; quoting makes them plain terms.
  for (const op of ['OR', 'AND', 'NOT', 'NEAR']) {
    assert.equal(buildFtsQuery(op), `"${op.toLowerCase()}"*`);
  }
});

test('returns empty for input with nothing searchable', () => {
  assert.equal(buildFtsQuery(''), '');
  assert.equal(buildFtsQuery('   '), '');
});

test('every output has balanced quotes', () => {
  // An unbalanced expression is a syntax error at query time, not an empty result.
  const inputs = ['a', 'a b', '"', '""', 'a"b"c', 'OR AND NOT', '%', '_', '\\', 'ünïcödé', '日本語', '-', '(', ')', '*', '^', ':'];
  for (const input of inputs) {
    const out = buildFtsQuery(input);
    const quotes = (out.match(/"/g) || []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes for ${JSON.stringify(input)}: ${out}`);
  }
});
