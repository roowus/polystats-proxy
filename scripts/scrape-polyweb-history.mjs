/**
 * One-shot importer: scrapes polyweb.ireo.dev WR histories (S/W/D tracks),
 * maps names to 0.6.3 track ids, and POSTs them to this worker's /history.
 *
 * Usage: BASE=https://polystats-proxy.roowus.workers.dev node scripts/scrape-polyweb-history.mjs
 * Or run against localhost during development.
 */
import { spawnSync } from 'node:child_process';

const BASE = (process.env.BASE ?? 'https://polystats-proxy.roowus.workers.dev').replace(/\/$/, '');
const ORIGIN = process.env.ORIGIN ?? 'https://polystats.roow.us';

// Track id catalog (game 0.6.3) — kept in sync with PolyStats src/lib/tracks.ts
const IDS = {
  'Summer 1': '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038',
  'Summer 2': '7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0',
  'Summer 3': '148826aa16ffaa23dbc453b32cff05e025ddbce1773fc7733cc13d218926515a',
  'Summer 4': '93c7363dfea7fb09ca1d23b72cad5df43a30841d41c8ff25fb544c85bb03c7ae',
  'Summer 5': '7603aaeffa1989a649dfaa8e1804bed4481b49df233e377687d0669899566e52',
  'Summer 6': 'c117823cf6788e3247b9ee63a0c091c07352bbe352c650a7790dc6718148c2fa',
  'Summer 7': 'e4bcaca3a583bb0eb62a700a69d14e89c852f0c5bf740fca76e0519ebdfc9ab1',
  'Winter 1': '7239b17057127936907a805b0caa5d8c6f6c97eca9bdabf1a5312dce479629b7',
  'Winter 2': '99864b635d1891d22e17eb9267527a07a92c49c0f02893729fa2ded90e3ca0f9',
  'Winter 3': 'a5341fe706097cff2a3812a3fc0d87399254557328351ae8e5c882700fc1a196',
  'Winter 4': '7d134c939df80c676a258266201beedd3b93572d5603f3ff4339ff8679803715',
  'Winter 5': '2fe4bd46b0075cc25fc770ce50adbb68447cf493c999635bb272d231811dd264',
  'Desert 1': 'c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34',
  'Desert 2': '88647ea04145fbbbb19b55f1590e038fb0378acb2571110f02cb545cc46b0d57',
  'Desert 3': '2806030c503abb41a1a26fa9a570888be14296172bb273798ef0ad87a108a2ec',
  'Desert 4': '4697ea67b18c3f49b30a3d8884602115536650bc5435c88e3732e64d21a72d33',
  'Desert 5': 'e5d084e06db4ab71196fea44efeceb23c8561266a78669c324a38f92581fe2db',
};
const CODES = Object.keys(IDS).map((n) => ({ code: n.replace(/^(Summer|Winter|Desert) /, (m, w) => w[0] + n.split(' ')[1]), name: n }));

function fetchText(url) {
  return spawnSync('curl', ['-sL', '--max-time', '60', '-A', 'Mozilla/5.0', url], { encoding: 'utf8' }).stdout;
}

const rows = [];
for (const name of Object.keys(IDS)) {
  const code = name.startsWith('Summer') ? 'S' : name.startsWith('Winter') ? 'W' : 'D';
  const num = name.split(' ')[1];
  const html = fetchText(`https://polyweb.ireo.dev/history/${code}${num}`);
  const rowRe = /<tr>\s*<td>(.*?)<\/td>\s*<td>([\d.]+)<\/td>\s*<td>([\d/: ]+)<\/td>\s*<td><button[^>]*data-recording="([^"]*)"/g;
  let count = 0;
  for (const m of html.matchAll(rowRe)) {
    const [, player, timeS, ts, recording] = m;
    rows.push({
      trackId: IDS[name],
      player: player.trim().slice(0, 80),
      timeMs: Math.round(parseFloat(timeS) * 1000),
      ts: ts.trim().replace(/\//g, '-') + 'Z', // 2026/03/10 15:48:59 -> ISO-ish
      recording: recording || null,
    });
    count += 1;
  }
  console.log(`${name}: ${count} rows`);
  if (count === 0) console.log(`  WARNING: no rows parsed for ${name} — page layout may have changed`);
}

console.log(`posting ${rows.length} rows to ${BASE}/history`);
const res = await fetch(`${BASE}/history`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ rows }),
});
console.log(res.status, (await res.text()).slice(0, 200));
