/**
 * Tests for the FTS MATCH builder.
 *
 * FTS5 has its own query syntax where quotes, `*`, and AND/OR/NOT are operators,
 * and a malformed expression throws instead of returning no rows. Since this
 * function receives raw user input, every case here must produce a syntactically
 * valid expression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of buildFtsQuery in worker/index.ts.
function buildFtsQuery(term) {
  return term
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word.replace(/"/g, '""')}"*`)
    .join(' ');
}

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

test('quotes FTS operators so they are treated as text', () => {
  // Unquoted, these would be parsed as operators rather than searched for.
  for (const op of ['OR', 'AND', 'NOT', 'NEAR']) {
    const out = buildFtsQuery(op);
    assert.equal(out, `"${op.toLowerCase()}"*`);
    assert.ok(out.startsWith('"') && out.endsWith('"*'));
  }
});

test('handles punctuation without producing an unbalanced expression', () => {
  for (const input of ['(', ')', '*', '-', '^', ':', '"']) {
    const out = buildFtsQuery(input);
    const quotes = (out.match(/"/g) || []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes for ${JSON.stringify(input)}: ${out}`);
  }
});

test('returns empty for input with nothing searchable', () => {
  assert.equal(buildFtsQuery(''), '');
  assert.equal(buildFtsQuery('   '), '');
});

test('every output has balanced quotes', () => {
  const inputs = ['a', 'a b', '"', '""', 'a"b"c', 'OR AND NOT', '%', '_', '\\', 'ünïcödé', '日本語'];
  for (const input of inputs) {
    const out = buildFtsQuery(input);
    const quotes = (out.match(/"/g) || []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes for ${JSON.stringify(input)}: ${out}`);
  }
});
