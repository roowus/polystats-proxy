# polystats-proxy

CORS proxy for [PolyStats](https://github.com/roowus/polystats). The PolyTrack
leaderboard API (`vps.kodub.com`) only accepts requests from the game's own
origin, so this small Cloudflare Worker adds the correct `Origin` header and
forwards the request. It only proxies `https://vps.kodub.com` — it is not an
open proxy.

## Deploy via Cloudflare Workers Builds (recommended)

1. In the Cloudflare dashboard: **Workers & Pages → Create → Workers → Connect to Git**
2. Authorize GitHub and pick this repository
3. Set the build config:
   - **Root directory**: `worker`
   - **Deploy command**: `npx wrangler deploy`
4. Deploy. The worker will be live at `https://polystats-proxy.<your-subdomain>.workers.dev`

Every push to `main` then deploys automatically.

## Deploy manually

```bash
cd worker
npx wrangler deploy
```

PolyStats expects the worker at the name `polystats-proxy` (see
`DEFAULT_PROXY_URL` in `src/lib/polytrack.ts`); if you rename it, also set the
`VITE_PROXY_URL` environment variable on the PolyStats Vercel project.
