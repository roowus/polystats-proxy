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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const requestUrl = new URL(request.url);
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
