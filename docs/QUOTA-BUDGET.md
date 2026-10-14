# D1 quota budget

Cloudflare D1's free tier allows, per day:

| Meter | Allowance | Reset |
| --- | --- | --- |
| Rows **read** | 5,000,000 | midnight UTC |
| Rows **written** | 100,000 | midnight UTC |
| Storage | 5 GB | n/a |

Reads and writes are **separate meters**. The scrapers were budgeted against
writes, which is why an earlier estimate concluded there was ~50% headroom: it
never counted reads that scale with *visitors* rather than with scrape volume.
That estimate was wrong, and the allowance was exhausted twice in one day,
which stops data collection because the scrapers share the database.

This document lists every consumer and its measured cost.

## How a row read is counted

A query costs one read **per row the database had to inspect**, not per query.
The difference matters:

- `SELECT value FROM meta WHERE key = ?` uses an index: **~1 read**.
- `SELECT COUNT(*) FROM users` must visit every row: **9,706 reads**.
- `WHERE nickname_lower LIKE 'x%'` with a `COLLATE NOCASE` index: **~1 per
  match**.
- `WHERE nickname_lower LIKE '%x%'` can never use an index: **9,706 reads**.

## Consumers

Measured against the live catalog (9,706 users, 14,050 results, 409 history
rows, 950 snapshots).

### Scrapers (scale with tracks, not visitors)

| Job | Schedule | Work per run | Reads/day |
| --- | --- | --- | --- |
| `watch` (WR watch) | every 5 min | 20-45 tracks x ~1 page | ~290,000 |
| `snapshot` | every 6 h | 63 tracks x 50 entries | ~13,000 |
| `backfill` | 2x/day | 6 tracks x 750 players | ~9,000 |
| `tick` | every 5 min | light | ~15,000 |
| **total** | | | **~327,000 (6.5%)** |

### User-facing (scale with visitors)

These are what the original estimate missed.

| Path | Cost per call | Calls before the day is spent |
| --- | --- | --- |
| `/status` (was `COUNT(*)` x5) | **25,116 reads** | **199** |
| Autocomplete substring scan | **9,706 reads** | **515** |
| Autocomplete prefix (FTS) | ~1 per match | effectively unlimited |
| Profile lookup (indexed) | ~5 reads | effectively unlimited |

`/status` was the worst offender: the site's freshness line fetched it on
**every page load**, so ~200 page views could consume the entire daily
allowance and stop the scrapers.

### One-off costs

| Source | Cost | Notes |
| --- | --- | --- |
| `ensureSchema` DDL on cold start | ~32 statements | Index probes, cheap |
| `nickname_lower` backfill UPDATE | **9,706 reads** | Ran on *every* cold start |

The backfill is the subtle one. It has to inspect every row to find rows needing
work, so once it had nothing left to do it was pure overhead, repeated whenever
Workers recycled an isolate.

## Fixes applied

| Fix | Effect |
| --- | --- |
| `/status` reads counts cached in `meta` | 25,116 reads -> **1** |
| Counts refreshed only by jobs (`recordCounts`) | moves the cost to scheduled work |
| Backfill gated on a `meta` flag | 9,706 reads per cold start -> **0** |
| Index on `nickname_lower COLLATE NOCASE` | prefix search index-backed; the collation is required for `LIKE` to use an index |
| Substring scans require a 4+ char term | short prefixes (most-retyped) use the indexed path |
| Per-isolate scan rationing | a burst cannot spend the collectors' budget |
| Client caches `/status` for 5 minutes | repeat navigation costs no calls |

## Budget after the fixes

| Consumer | Reads/day | % of 5M |
| --- | --- | --- |
| Scrapers | ~327,000 | 6.5% |
| `/status` (1 read, cached 5 min client-side) | ~10,000 | 0.2% |
| Autocomplete (FTS path) | ~50,000 | 1.0% |
| Profile lookups | ~10,000 | 0.2% |
| Substring scans (rationed, 25/isolate) | <=250,000 | 5.0% |
| **total** | **~650,000** | **~13%** |

Headroom is now roughly 8x, and the expensive paths are capped rather than
proportional to traffic.

## Risks

- **Scan rationing is per isolate.** A burst spread across many isolates gets a
  larger combined allowance than the constant suggests: one isolate caps at
  ~243k reads (4.9% of the day), but 20 isolates each hitting the cap would
  still exhaust it. It is a brake, not a hard quota. The FTS path is what
  actually keeps ordinary search off the budget.
- **The budget grows with the catalog.** At 100,000 users a substring scan costs
  100,000 reads, so ~50 scans would spend the day. The FTS path is what keeps
  that from mattering; the scan stays the fallback for interior fragments only.
- **Counts are now eventual.** `/status` reports the values written by the last
  job run, so they lag by up to one schedule interval. A live count would cost
  25k reads per page view.

## Checking usage

The Cloudflare dashboard shows read/write totals under **Workers & Pages -> D1
-> polystats-catalog -> Metrics**. `GET /status` reports the catalog's own row
counts and the last run times for each job.
