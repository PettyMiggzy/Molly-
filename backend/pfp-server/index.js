/*
  Molly PFP Server

  Stores profile pictures keyed by wallet address.
  Upload requires:
    1. A signed message (proves wallet ownership)
    2. The wallet holds 100K MOLLY (verified via QuickNode RPC)

  Endpoints:
    GET  /pfp/:address              → image file (jpg/png/webp) or 404
    GET  /eligibility/:address      → { eligible: bool, balance: string }
    POST /pfp                       → upload (body: { address, message, signature, imageDataUrl })
    DELETE /pfp                     → remove (body: { address, message, signature })
    GET  /health                    → { ok: true, uptime, pfp_count }

  Deployment:
    PM2 process name: molly-pfp
    Port: 3002 (alongside monpad-server on 3001)
    Behind nginx as either api.monpad.net/molly/* or pfp.mollyonmonad.xyz

  Env vars (.env):
    PORT=3002
    QUICKNODE_RPC=https://your-endpoint.monad-mainnet.quiknode.pro/your-key/
    PFP_DIR=./pfps
    HOLD_REQUIRED_WEI=100000000000000000000000   # 100K * 1e18
*/

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { ethers } = require('ethers');

const PORT             = parseInt(process.env.PORT || '3002', 10);
const QUICKNODE_RPC    = process.env.QUICKNODE_RPC || 'https://rpc.monad.xyz';
const PFP_DIR          = path.resolve(process.env.PFP_DIR || './pfps');
const HOLD_REQUIRED    = BigInt(process.env.HOLD_REQUIRED_WEI || '100000000000000000000000');
const MAX_UPLOAD_BYTES = 512 * 1024;          // 500KB after base64 decode
const SIG_TTL_MS       = 5 * 60 * 1000;        // 5 min replay window
const MOLLY_TOKEN      = '0xB72e6262DAE53cAF167F0966421a0B9782977777';

// ---- bootstrap ----
fs.mkdirSync(PFP_DIR, { recursive: true });
console.log(`[molly-pfp] storage: ${PFP_DIR}`);
console.log(`[molly-pfp] rpc:     ${QUICKNODE_RPC.replace(/\/[^\/]+\/?$/, '/***')}`);

const provider = new ethers.JsonRpcProvider(QUICKNODE_RPC);

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '8mb' }));

// ---- helpers ----
function isAddr(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function findPfp(addr) {
  const lower = addr.toLowerCase();
  for (const ext of ['jpg', 'png', 'webp']) {
    const p = path.join(PFP_DIR, `${lower}.${ext}`);
    if (fs.existsSync(p)) return { path: p, ext };
  }
  return null;
}

async function balanceOfMolly(addr) {
  const data = '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0');
  const result = await provider.call({ to: MOLLY_TOKEN, data });
  return BigInt(result);
}

function verifyUpload(body) {
  const { address, message, signature } = body;
  if (!isAddr(address)) return { error: 'bad address' };
  if (typeof message !== 'string' || typeof signature !== 'string') {
    return { error: 'missing message/signature' };
  }
  // Replay protection — message must contain a recent timestamp
  const tsMatch = message.match(/timestamp:(\d+)/);
  if (!tsMatch) return { error: 'message missing timestamp' };
  const ts = parseInt(tsMatch[1], 10);
  if (!ts || Math.abs(Date.now() - ts) > SIG_TTL_MS) {
    return { error: 'signature expired' };
  }
  // Recover signer
  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (e) {
    return { error: 'invalid signature' };
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { error: 'signature does not match address' };
  }
  return { ok: true };
}

// ---- routes ----

app.get('/health', (_req, res) => {
  let count = 0;
  try { count = fs.readdirSync(PFP_DIR).filter(f => /\.(jpg|png|webp)$/.test(f)).length; } catch {}
  res.json({ ok: true, uptime: process.uptime(), pfp_count: count });
});

// Public read — no auth, no gating, anyone can fetch any PFP
app.get('/pfp/:address', (req, res) => {
  const addr = req.params.address;
  if (!isAddr(addr)) return res.status(400).send('bad address');
  const found = findPfp(addr);
  if (!found) return res.status(404).send('no pfp');
  // Cache hint
  res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min
  res.sendFile(found.path);
});

// Eligibility check — public, used by free-play banner
app.get('/eligibility/:address', async (req, res) => {
  const addr = req.params.address;
  if (!isAddr(addr)) return res.status(400).json({ error: 'bad address' });
  try {
    const balance = await balanceOfMolly(addr);
    const eligible = balance >= HOLD_REQUIRED;
    res.json({
      eligible,
      balance: balance.toString(),
      balanceMolly: (balance / 10n ** 18n).toString(),
      required: HOLD_REQUIRED.toString(),
      requiredMolly: (HOLD_REQUIRED / 10n ** 18n).toString(),
    });
  } catch (e) {
    console.error('[eligibility]', e.message);
    res.status(500).json({ error: 'rpc failed' });
  }
});

// Upload — signed + balance-gated
app.post('/pfp', async (req, res) => {
  try {
    const v = verifyUpload(req.body);
    if (v.error) return res.status(401).json({ error: v.error });

    const { address, imageDataUrl } = req.body;
    if (typeof imageDataUrl !== 'string') {
      return res.status(400).json({ error: 'missing imageDataUrl' });
    }

    // Parse data URL header
    const m = imageDataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'unsupported image format' });
    const ext = (m[1] === 'jpeg' ? 'jpg' : m[1]);
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `image too large (max ${MAX_UPLOAD_BYTES} bytes)` });
    }

    // Balance check — hold 100K MOLLY
    const balance = await balanceOfMolly(address);
    if (balance < HOLD_REQUIRED) {
      return res.status(403).json({
        error: 'need 100K MOLLY to upload',
        balance: balance.toString(),
        required: HOLD_REQUIRED.toString(),
      });
    }

    // Write atomically: tmp file, fsync, rename
    const lower = address.toLowerCase();
    const finalPath = path.join(PFP_DIR, `${lower}.${ext}`);
    const tmpPath   = path.join(PFP_DIR, `.${lower}.${ext}.${crypto.randomBytes(4).toString('hex')}.tmp`);

    // Clear other extensions if user switches format
    for (const oldExt of ['jpg', 'png', 'webp']) {
      if (oldExt === ext) continue;
      const oldPath = path.join(PFP_DIR, `${lower}.${oldExt}`);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, finalPath);

    console.log(`[pfp] ${lower} updated · ${buf.length}b · ${ext}`);
    res.json({ ok: true, url: `/pfp/${lower}`, ext, size: buf.length });
  } catch (e) {
    console.error('[upload]', e);
    res.status(500).json({ error: 'server error' });
  }
});

// Remove
app.delete('/pfp', (req, res) => {
  const v = verifyUpload(req.body);
  if (v.error) return res.status(401).json({ error: v.error });

  const lower = req.body.address.toLowerCase();
  let removed = false;
  for (const ext of ['jpg', 'png', 'webp']) {
    const p = path.join(PFP_DIR, `${lower}.${ext}`);
    if (fs.existsSync(p)) { fs.unlinkSync(p); removed = true; }
  }
  console.log(`[pfp] ${lower} removed: ${removed}`);
  res.json({ ok: true, removed });
});

app.listen(PORT, () => {
  console.log(`[molly-pfp] listening on :${PORT}`);
});
