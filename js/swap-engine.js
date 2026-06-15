/* ════════════════════════════════════════════════════════════
   MOYAKI UNIVERSAL SWAP ENGINE
   Powered by Monorail aggregator (pathfinder.monorail.xyz/v4)
   - One API call returns ready-to-broadcast transaction
   - Routes across Kuru, Crystal, Clober, Capricorn, Octoswap,
     Atlantis, IziSwap, LFJ, Uniswap V3, and others
   - Works for ANY token on Monad — no protocol-specific code
   - Native MON via 0x0 sentinel address
   - Free, no auth/API key needed, fully CORS-open

   Fee routing: 1% of every swap flows to the registered App ID's
   treasury wallet. The flywheel processes that wallet automatically.

   Requires: ethers.js v6 UMD loaded before this script
   ════════════════════════════════════════════════════════════ */
(function(){
'use strict';

if (!window.ethers) { console.error('moyaki-swap requires ethers v6 UMD'); return; }

const CHAIN_ID    = 143;
const CHAIN_HEX   = '0x8f';
const NATIVE_ZERO = '0x0000000000000000000000000000000000000000';
const EXPLORER    = 'https://monadexplorer.com';

const MONORAIL = {
  QUOTE:  'https://pathfinder.monorail.xyz/v4/quote',
  TOKENS: 'https://api.monorail.xyz/v2/tokens',
  APP_ID: '1176408161625',  // 1% fee → flywheel treasury wallet
};

// Same-origin proxy first (avoids ad-blocker / strict-DNS issues). Then
// the public Monad RPC as fallback. Removed monad-mainnet.public.blastapi.io
// from the list after King reported DNS no longer resolves (NXDOMAIN).
const RPC_URLS = ['/api/rpc', 'https://rpc.monad.xyz'];

const tokenIface = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

// Try ALL RPC URLs in parallel, use the first valid response. This is
// resilient to ad-blockers (blocks one but not all), Vercel function cold
// starts (rpc.monad.xyz returns fast even if /api/rpc is warming up), and
// regional flakiness. Whichever responds first wins.
async function rpcCall(method, params){
  const body = JSON.stringify({jsonrpc:'2.0', id:Date.now(), method, params});
  const errors = [];
  const tries = RPC_URLS.map(url => new Promise(async (resolve, reject) => {
    try{
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body,
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok){ errors.push(url + ' http ' + r.status); return reject(); }
      const j = await r.json();
      if (j.error){ errors.push(url + ' rpc ' + (j.error.message || '?')); return reject(); }
      resolve(j.result);
    }catch(e){
      errors.push(url + ' ' + (e && e.message ? e.message : String(e)));
      reject();
    }
  }));
  try{
    return await Promise.any(tries);
  }catch(e){
    // All failed — surface a useful message with each URL's failure mode
    throw new Error('RPC unreachable: ' + errors.join(' | '));
  }
}

async function ethCall(to, data, blockTag){
  return rpcCall('eth_call', [{to, data}, blockTag || 'latest']);
}

function parseUnitsBig(amount, decimals){
  return ethers.parseUnits(String(amount), decimals);
}

async function monorailQuote({from, to, amount, sender, slippageBps, deadlineSec}){
  const params = new URLSearchParams({
    from: from || NATIVE_ZERO,
    to,
    amount: String(amount),
    sender,
    slippage: String(slippageBps || 100),
    source: MONORAIL.APP_ID,
  });
  if (deadlineSec) params.set('deadline', String(deadlineSec));
  const url = `${MONORAIL.QUOTE}?${params.toString()}`;
  let j;
  try{
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(url, {cache:'no-cache', signal: ctrl.signal});
    clearTimeout(t);
    if (!r.ok) throw new Error('Monorail HTTP ' + r.status);
    j = await r.json();
  }catch(e){
    if (e && e.name === 'AbortError') throw new Error('Monorail quote timed out — slow network');
    throw new Error('Monorail unreachable: ' + (e && e.message ? e.message : 'network error'));
  }
  if (j.message && !j.transaction){
    throw new Error(j.message);
  }
  return j;
}

async function quoteRoute({from, to, amount, sender, slippageBps}){
  const q = await monorailQuote({from, to, amount, sender, slippageBps});
  q._source = 'monorail';
  return q;
}

async function tokenBalance(token, owner){
  const data = tokenIface.encodeFunctionData('balanceOf', [owner]);
  const res = await ethCall(token, data);
  const [bal] = tokenIface.decodeFunctionResult('balanceOf', res);
  return bal;
}
async function tokenAllowance(token, owner, spender){
  const data = tokenIface.encodeFunctionData('allowance', [owner, spender]);
  const res = await ethCall(token, data);
  const [a] = tokenIface.decodeFunctionResult('allowance', res);
  return a;
}
async function nativeBalance(owner){
  const hex = await rpcCall('eth_getBalance', [owner, 'latest']);
  return BigInt(hex);
}
async function tokenInfo(token){
  const calls = [
    tokenIface.encodeFunctionData('symbol', []),
    tokenIface.encodeFunctionData('name', []),
    tokenIface.encodeFunctionData('decimals', []),
  ];
  const out = {};
  try{
    const [sR, nR, dR] = await Promise.all(calls.map(d => ethCall(token, d)));
    out.symbol   = tokenIface.decodeFunctionResult('symbol',  sR)[0];
    out.name     = tokenIface.decodeFunctionResult('name',    nR)[0];
    out.decimals = Number(tokenIface.decodeFunctionResult('decimals', dR)[0]);
  }catch(e){
    out.symbol = '?'; out.name = '?'; out.decimals = 18;
  }
  return out;
}

async function ensureMonadChain(){
  try{
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{chainId: CHAIN_HEX}],
    });
  }catch(e){
    if (e && e.code === 4902){
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_HEX,
          chainName: 'Monad Mainnet',
          nativeCurrency: {name:'Monad', symbol:'MON', decimals:18},
          rpcUrls: ['https://rpc.monad.xyz'],
          blockExplorerUrls: [EXPLORER],
        }],
      });
    } else throw e;
  }
}
async function connect(){
  if (!window.ethereum){
    throw new Error('No wallet detected. Open in MetaMask, Rabby, Phantom, or Trust Wallet.');
  }
  const accounts = await window.ethereum.request({method:'eth_requestAccounts'});
  await ensureMonadChain();
  return accounts[0];
}
function isConnected(){ return !!(window.ethereum && window.ethereum.selectedAddress); }

async function sendTx(params){
  return window.ethereum.request({method:'eth_sendTransaction', params:[params]});
}
async function waitReceipt(hash, maxMs=90000){
  const start = Date.now();
  while (Date.now() - start < maxMs){
    try{
      const r = await rpcCall('eth_getTransactionReceipt', [hash]);
      if (r && r.blockNumber) return r;
    }catch(e){}
    await new Promise(r=>setTimeout(r, 1500));
  }
  return null;
}

async function simulateCall(to, data, fromAccount, value){
  const isHex = typeof value === 'string';
  const valueBig = isHex ? BigInt(value) : (value || 0n);
  const overrideBalance = valueBig > 0n ? (valueBig * 4n) + 10n**18n : 10n**18n;
  const call = { from: fromAccount, to, data };
  if (valueBig > 0n) call.value = isHex ? value : '0x'+valueBig.toString(16);
  const params = [
    call,
    'latest',
    { [fromAccount]: { balance: '0x'+overrideBalance.toString(16) } }
  ];
  try{
    await rpcCall('eth_call', params);
    return { ok: true };
  }catch(e){
    return { ok: false, error: e };
  }
}

function explainRevert(err){
  const m = (err && (err.message || err.shortMessage || String(err))) || '';
  const low = m.toLowerCase();
  if (low.includes('no valid routes'))
    return 'No swap route found. Token may have zero liquidity.';
  if (low.includes('swap amount is required'))
    return 'Enter an amount to swap.';
  if (low.includes('insufficient balance') || low.includes('insufficient funds'))
    return 'Not enough balance to cover this trade + gas.';
  if (low.includes('insufficient_output_amount') || low.includes('amount_out_min') || low.includes('slippage'))
    return 'Slippage too tight — price moved between quote and execution. Try 3% or 5%.';
  if (low.includes('expired') || low.includes('deadline'))
    return 'Tx deadline passed. Retry the trade.';
  if (low.includes('transfer_failed') || low.includes('transfer failed'))
    return 'Token transfer blocked. Token may have transfer restrictions.';
  if (low.includes('user denied') || low.includes('user rejected'))
    return 'Wallet signature cancelled.';
  if (low.includes('execution reverted') && !low.includes('reason'))
    return 'Trade simulation failed. Try a smaller amount or larger slippage.';
  return m || 'Unknown error';
}

async function executeSwap({from, to, amountHuman, slippageBps, account, onApproveStarted, onApproveConfirmed}){
  const fromAddr = (from && from !== NATIVE_ZERO) ? from : NATIVE_ZERO;
  const toAddr   = (to && to !== NATIVE_ZERO)     ? to   : NATIVE_ZERO;
  if (fromAddr.toLowerCase() === toAddr.toLowerCase()){
    throw new Error('From and To tokens are the same.');
  }
  const q = await quoteRoute({
    from: fromAddr, to: toAddr,
    amount: amountHuman, sender: account, slippageBps,
  });
  if (!q.transaction) throw new Error('No transaction returned');

  const isNativeFrom = fromAddr === NATIVE_ZERO;

  if (!isNativeFrom){
    const spender = q.transaction.to;
    const amountInWei = BigInt(q.input);
    const current = await tokenAllowance(fromAddr, account, spender);
    if (current < amountInWei){
      if (onApproveStarted) onApproveStarted();
      // Exact-amount approval (not MaxUint256) — unlimited approvals trigger MetaMask/Blockaid spending-cap warnings.
      const approveData = tokenIface.encodeFunctionData('approve', [spender, amountInWei]);
      const simA = await simulateCall(fromAddr, approveData, account, null);
      if (!simA.ok) throw new Error('Approve will fail: ' + explainRevert(simA.error));
      const approveTx = await sendTx({ from: account, to: fromAddr, data: approveData });
      const rec = await waitReceipt(approveTx, 90000);
      if (!rec) throw new Error('Approve tx not confirmed in 90s — try again');
      if (onApproveConfirmed) onApproveConfirmed(approveTx);
    }
  }

  const valueForSim = isNativeFrom ? q.transaction.value : '0x0';
  const sim = await simulateCall(q.transaction.to, q.transaction.data, account, valueForSim);
  if (!sim.ok) throw new Error(explainRevert(sim.error));

  const txHash = await sendTx({
    from: account,
    to: q.transaction.to,
    data: q.transaction.data,
    value: isNativeFrom ? q.transaction.value : '0x0',
  });
  return { txHash, quote: q };
}

async function searchTokens(query){
  const url = `${MONORAIL.TOKENS}?find=${encodeURIComponent(query)}`;
  try{
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  }catch(e){ return []; }
}

window.MoyakiSwap = {
  CHAIN_ID, CHAIN_HEX, EXPLORER, NATIVE_ZERO, MONORAIL,
  monorailQuote, quoteRoute, searchTokens,
  connect, isConnected, ensureMonadChain,
  tokenBalance, tokenAllowance, nativeBalance, tokenInfo,
  executeSwap, waitReceipt,
  rpcCall, ethCall, explainRevert,
};

})();
