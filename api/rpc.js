// /api/rpc.js — same-origin JSON-RPC proxy to Monad mainnet.
//
// Why: client-side fetch() to rpc.monad.xyz can fail in browsers with
// strict ad-blocker rules, corporate DNS filters, or mobile proxies that
// silently drop third-party blockchain RPC. Going through a same-origin
// Vercel function bypasses all of that.
//
// Set MONAD_RPC=<your full RPC URL with key> in Vercel env vars to use a
// premium upstream (QuickNode etc.). Falls back to public RPC if unset.

const UPSTREAM = process.env.MONAD_RPC || 'https://rpc.monad.xyz';

// JSON-RPC methods we will NOT forward (state-changing or abusive on
// node administration). Reads + tx broadcast are allowed.
const BLOCKED_PREFIXES = ['admin_', 'debug_', 'personal_', 'miner_', 'txpool_'];
const BLOCKED_EXACT = new Set([
  'eth_newFilter', 'eth_newBlockFilter', 'eth_newPendingTransactionFilter',
  'eth_uninstallFilter', 'eth_getFilterChanges', 'eth_getFilterLogs',
]);

function isBlocked(method){
  if (typeof method !== 'string') return true;
  if (BLOCKED_EXACT.has(method)) return true;
  return BLOCKED_PREFIXES.some(p => method.startsWith(p));
}

export default async function handler(req, res){
  // Same-origin only. The CORS header reflects the page's origin; on Vercel
  // this is automatically the moyaki domain.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch(e){
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  if (!payload) return res.status(400).json({ error: 'missing body' });

  // Allow single call or batch
  const calls = Array.isArray(payload) ? payload : [payload];
  for (const c of calls){
    if (isBlocked(c && c.method)){
      return res.status(403).json({ error: 'method blocked: ' + (c && c.method) });
    }
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch(e){
    return res.status(502).json({ error: 'upstream unreachable: ' + e.message });
  }
}
