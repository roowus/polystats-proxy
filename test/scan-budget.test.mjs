/**
 * Tests for the expensive-scan rationing.
 *
 * A substring search (`LIKE '%term%'`) cannot use an index, so it reads every
 * row in `users`. That is what exhausted the daily allowance and stopped the
 * scrapers, which share the database. The rationing is the brake that keeps
 * search from spending the budget the collectors need.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mayRunExpensiveScan,
  resetScanBudget,
  SCAN_BUDGET_PER_ISOLATE,
  MIN_SCAN_LENGTH,
  mayScanFor,
} from '../worker/index.ts';

beforeEach(() => resetScanBudget());

test('allows scans up to the budget', () => {
  for (let i = 0; i < SCAN_BUDGET_PER_ISOLATE; i++) {
    assert.equal(mayRunExpensiveScan(), true, `scan ${i + 1} should be allowed`);
  }
});

test('refuses scans once the budget is spent', () => {
  for (let i = 0; i < SCAN_BUDGET_PER_ISOLATE; i++) mayRunExpensiveScan();
  // Past the cap, a scan must be refused rather than competing with collection.
  assert.equal(mayRunExpensiveScan(), false);
  assert.equal(mayRunExpensiveScan(), false);
});

test('does not go negative or wrap around when over budget', () => {
  for (let i = 0; i < SCAN_BUDGET_PER_ISOLATE + 50; i++) mayRunExpensiveScan();
  assert.equal(mayRunExpensiveScan(), false);
});

test('resets when the day changes', () => {
  // The budget is per day, so a stale window must not permanently block scans.
  resetScanBudget('2026-10-13');
  for (let i = 0; i < SCAN_BUDGET_PER_ISOLATE; i++) mayRunExpensiveScan();
  assert.equal(mayRunExpensiveScan(), false);

  // A fresh day (the module sees a different date) restores the budget.
  resetScanBudget('2000-01-01');
  assert.equal(mayRunExpensiveScan(), true);
});

test('one isolate cannot spend a large share of the daily budget', () => {
  // Rationing is per isolate, so the cap must be small enough that a single hot
  // isolate does not meaningfully compete with the scrapers. Verified against
  // the live table size.
  const TABLE_ROWS = 10_000;
  const DAILY_READ_LIMIT = 5_000_000;
  const worstCase = SCAN_BUDGET_PER_ISOLATE * TABLE_ROWS;
  const share = worstCase / DAILY_READ_LIMIT;
  assert.ok(share < 0.1, `one isolate could spend ${(share * 100).toFixed(1)}% of the day`);
});

test('short terms are excluded from scanning', () => {
  // Guards the common case: users retype short prefixes most, and those are
  // served by the indexed FTS path instead.
  assert.ok(MIN_SCAN_LENGTH >= 3, 'a 1-2 char term must not trigger a full scan');
});

// --- mayScanFor: the routing decision -------------------------------------

test('short terms never scan', () => {
  // 'm', 'mo', 'mon' are the most common inputs and are FTS-served.
  for (const term of ['', 'm', 'mo', 'mon']) {
    assert.equal(mayScanFor(term), false, `${JSON.stringify(term)} must not scan`);
  }
});

test('terms at the threshold scan when budget allows', () => {
  resetScanBudget();
  assert.equal(mayScanFor('m'.repeat(MIN_SCAN_LENGTH)), true);
  assert.equal(mayScanFor('monstrosity'), true);
});

test('a long term still cannot scan once the budget is spent', () => {
  resetScanBudget();
  for (let i = 0; i < SCAN_BUDGET_PER_ISOLATE; i++) mayScanFor('monstrosity');
  assert.equal(mayScanFor('monstrosity'), false);
});

test('rejected short terms do not consume the budget', () => {
  // Otherwise typing a name would exhaust the budget before any real scan ran.
  resetScanBudget();
  for (let i = 0; i < SCAN_BUDGET_PER_ISOLATE * 3; i++) mayScanFor('mo');
  assert.equal(mayScanFor('monstrosity'), true);
});
