# Testing the worker

The proxy shares a D1 database with the scrapers, and D1's free tier meters row
reads per day. A full-scan query repeated enough times can spend that allowance
and stop data collection, so run anything repetitive against a **local** copy,
not production.

## Local

```bash
npm install
npm run dev          # wrangler dev --local, state in .wrangler/state
npm test             # pure-function tests, no network
npm run typecheck
```

`wrangler dev --local` uses a local SQLite file, so experiments cost nothing and
cannot interrupt collection.

## Production

Read-only checks are fine (a handful of requests). Avoid loops, load tests, or
repeated runs of the same search against the deployed worker.

If you do exhaust the allowance, every query returns
`D1_ERROR: ... exceeded D1's free tier daily row read limit` until midnight UTC,
and both the API and the cron jobs fail until then.
