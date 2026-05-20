# Molly PFP Server

Stores profile pictures keyed by wallet address. Uploads require:
1. A signed message proving wallet ownership (replay-protected via timestamp)
2. The wallet holds 100K+ MOLLY (verified on-chain via QuickNode RPC)

## Endpoints

| method | path | auth | notes |
| :--- | :--- | :--- | :--- |
| GET | `/pfp/:address` | public | returns image file or 404 |
| GET | `/eligibility/:address` | public | `{ eligible, balance, required }` |
| POST | `/pfp` | signature | body: `{ address, message, signature, imageDataUrl }` |
| DELETE | `/pfp` | signature | body: `{ address, message, signature }` |
| GET | `/health` | public | `{ ok, uptime, pfp_count }` |

### Message format (for POST/DELETE)
```
Molly PFP update for 0x... timestamp:1747700000000
```
Must include `timestamp:<unix-ms>` within the last 5 minutes.

## Local setup

```bash
cd backend/pfp-server
cp .env.example .env  # fill in QUICKNODE_RPC
npm install
npm start             # http://localhost:3002
```

Test:
```bash
curl http://localhost:3002/health
curl http://localhost:3002/eligibility/0xB9d4B73bE18914c6d64Bee65a806648370be467f
```

## Deploy to DigitalOcean droplet (138.68.248.211)

Runs alongside the existing `monpad-server` (port 3001) and `monshi-buybot`.

```bash
# 1. SSH in
ssh root@138.68.248.211

# 2. Clone or pull repo
cd /opt
git clone https://github.com/PettyMiggzy/Molly-.git molly  # first time
# or: cd /opt/molly && git pull

cd /opt/molly/backend/pfp-server

# 3. Configure
cp .env.example .env
nano .env  # set QUICKNODE_RPC to your real endpoint with key

# 4. Install + start with PM2
npm install --omit=dev
pm2 start index.js --name molly-pfp
pm2 save                    # persist process list across reboots
pm2 logs molly-pfp          # tail logs

# 5. Test
curl http://localhost:3002/health
```

## nginx routing

Two options for exposing the service publicly:

### Option A: api.monpad.net/molly/* (reuse existing domain)

In `/etc/nginx/sites-available/api.monpad.net`:

```nginx
location /molly/ {
    proxy_pass http://127.0.0.1:3002/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Pass through CORS preflight
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin "*";
        add_header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS";
        add_header Access-Control-Allow-Headers "Content-Type";
        return 204;
    }

    # 8MB max upload (matches express limit)
    client_max_body_size 8M;
}
```

Then `nginx -t && systemctl reload nginx`.

Frontend uses: `https://api.monpad.net/molly/pfp/0xabc...`

### Option B: pfp.mollyonmonad.xyz (dedicated subdomain)

Add DNS A-record `pfp.mollyonmonad.xyz → 138.68.248.211`, then a new nginx config that proxies everything to `127.0.0.1:3002`. Add LetsEncrypt cert.

Frontend uses: `https://pfp.mollyonmonad.xyz/pfp/0xabc...`

## Storage

Images live in `./pfps/` (or wherever `PFP_DIR` env points). One file per address:
- `0x<address>.jpg` or `.png` or `.webp`
- Max 500KB after base64 decode (frontend already resizes to 256px)
- Old format files deleted when user switches (jpg → png replaces old jpg)

For backups, snapshot `/opt/molly/backend/pfp-server/pfps/` periodically.

## Security notes

- **No auth header / cookies** — everything is signature-gated per request
- **Replay protection** — message timestamp must be within ±5 minutes
- **Rate limiting** — not built in; add via nginx if abuse appears
- **CORS** — wide open (`*`). Tighten in production if needed
- **MOLLY balance** is read live via QuickNode on every upload (no caching) so revoking eligibility is instant
- **No DELETE-all** endpoint — must own each address to remove its PFP

## Frontend integration

```javascript
// Upload
const message = `Molly PFP update for ${address} timestamp:${Date.now()}`;
const signature = await window.ethereum.request({
  method: 'personal_sign',
  params: [message, address],
});

await fetch('https://api.monpad.net/molly/pfp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address, message, signature, imageDataUrl }),
});

// Display (any user, no auth needed)
const url = `https://api.monpad.net/molly/pfp/${someAddress}`;
imgElement.src = url;
imgElement.onerror = () => { imgElement.src = './fallback.png'; };

// Check eligibility
const res = await fetch(`https://api.monpad.net/molly/eligibility/${address}`);
const { eligible, balanceMolly } = await res.json();
```
