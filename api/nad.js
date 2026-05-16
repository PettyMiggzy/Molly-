// /api/nad.js
// Server-side proxy for api.nadapp.net.
//
// Routes /api/nad/* → https://api.nadapp.net/* with:
//   1. Key rotation across 3 API keys (random pick per request)
//   2. Edge caching of GET responses (s-maxage=20, SWR=60)
//   3. Keys kept off the client (never reach the browser)
//
// Path extraction: reads req.url and strips the /api/nad/ prefix so we
// support /api/nad/order/creation_time?page=1 etc directly without needing
// Vercel rewrites. Also supports rewrite-style req.query._p for safety.
//
// Effective ceiling: ~1000+ concurrent users before any 429 risk.

const NAD_KEYS = [
  'nadfun_xY2HNrb6fQGwIHXH63mFNovyyprIR6cL',  // MonWolf Hub
  'nadfun_NLXREacOeG2VIzQx3Yy6QSrtgXliDjtV',  // MonWolf Hub 2
  'nadfun_2xM38qnw5dZppF5ElhcOi2bGNaFNueyP',  // Spare (shared w/ Chogi)
];

const BASE = 'https://api.nadapp.net';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    // Extract upstream path. Two paths supported:
    //   A: Direct routing via vercel.json rewrite → req.query._p = 'order/creation_time'
    //   B: Direct URL inspection → /api/nad/order/creation_time?page=1
    let upstreamPath, upstreamQuery = '';

    if (req.query && req.query._p) {
      upstreamPath = Array.isArray(req.query._p) ? req.query._p.join('/') : String(req.query._p);
      // Rebuild query string from remaining params
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (k === '_p') continue;
        if (Array.isArray(v)) v.forEach(vv => params.append(k, vv));
        else if (v !== undefined && v !== null) params.append(k, String(v));
      }
      upstreamQuery = params.toString();
    } else {
      // Parse from req.url — handles direct routing without rewrites
      const url = req.url || '';
      const qIdx = url.indexOf('?');
      const pathPart = qIdx >= 0 ? url.slice(0, qIdx) : url;
      upstreamQuery = qIdx >= 0 ? url.slice(qIdx + 1) : '';

      // Strip /api/nad prefix (handles /api/nad, /api/nad/, /api/nad/x/y)
      let rel = pathPart.replace(/^\/api\/nad\/?/, '');
      // Remove leading slashes
      rel = rel.replace(/^\/+/, '');
      upstreamPath = rel;
    }

    if (!upstreamPath) {
      res.status(400).json({ error: 'missing nad.fun path. Use /api/nad/{endpoint}' });
      return;
    }

    const targetUrl = `${BASE}/${upstreamPath}${upstreamQuery ? '?' + upstreamQuery : ''}`;

    // Random key from rotation pool
    const apiKey = NAD_KEYS[Math.floor(Math.random() * NAD_KEYS.length)];

    const upstreamOpts = {
      method: req.method,
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
      },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      upstreamOpts.headers['Content-Type'] = 'application/json';
      if (req.body !== undefined && req.body !== null) {
        upstreamOpts.body = typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body);
      }
    }

    const upstream = await fetch(targetUrl, upstreamOpts);

    const rl = upstream.headers.get('x-ratelimit-limit');
    const rr = upstream.headers.get('x-ratelimit-remaining');
    if (rl) res.setHeader('X-RL-Limit', rl);
    if (rr) res.setHeader('X-RL-Remaining', rr);

    if (req.method === 'GET' && upstream.ok) {
      res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=60');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.status(upstream.status);

    const text = await upstream.text();
    res.send(text);
  } catch (e) {
    console.error('nad proxy crashed:', e);
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'proxy failed', detail: e.message });
  }
};
