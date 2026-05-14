/* MOYAKI Mobile Wallet helper
   On iOS/Android Safari/Chrome, window.ethereum is NOT injected — wallets
   only inject inside their own in-app browser. This shows a bottom-sheet
   with deep-links that re-open the current page inside the chosen wallet's
   browser, where window.ethereum DOES exist. Without this, mobile users
   can't connect. */
(function () {
  if (window.MoyakiWallet) return;

  function isMobile(){ return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent); }
  function isInWalletBrowser(){ return !!window.ethereum; }

  // Build deep links from the live host so this works on any deploy
  // (moyaki-beta.vercel.app today, moyaki.xyz tomorrow, etc.)
  function deeplinks(){
    var host = window.location.hostname;  // e.g. moyaki-beta.vercel.app
    var pathPart = window.location.pathname + window.location.search + window.location.hash;
    var fullPath = pathPart.replace(/^\/+/, '');     // 'swap'
    var hostAndPath = host + (fullPath ? '/' + fullPath : '');
    var encoded = encodeURIComponent(hostAndPath);
    return {
      metamask: 'https://metamask.app.link/dapp/' + hostAndPath,
      rabby:    'https://rabby.io/dapp?url=' + encoded,
      phantom:  'https://phantom.app/ul/browse/' + encoded,
      trust:    'https://link.trustwallet.com/open_url?coin_id=60&url=' + encoded,
    };
  }

  function injectStyles(){
    if (document.getElementById('moyaki-wallet-style')) return;
    var s = document.createElement('style');
    s.id = 'moyaki-wallet-style';
    s.textContent =
      '#moyaki-wallet-modal{position:fixed;inset:0;z-index:2147483647;display:none;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.7);backdrop-filter:blur(8px);padding:0;}'+
      '#moyaki-wallet-modal.show{display:flex;}'+
      '#moyaki-wallet-sheet{width:100%;max-width:560px;background:linear-gradient(180deg,#1a1138,#0c0820);border:1.5px solid rgba(255,215,87,.5);border-bottom:0;border-radius:22px 22px 0 0;padding:22px 20px max(28px,env(safe-area-inset-bottom)) 20px;box-shadow:0 -16px 60px rgba(0,0,0,.6),0 0 36px rgba(255,215,87,.18);font-family:"Space Grotesk",system-ui,sans-serif;color:#f3eefe;animation:moyakiSheetUp .28s cubic-bezier(.2,.9,.2,1);}'+
      '@keyframes moyakiSheetUp{from{transform:translateY(100%);}to{transform:translateY(0);}}'+
      '#moyaki-wallet-sheet .grip{width:42px;height:5px;border-radius:3px;background:rgba(255,255,255,.2);margin:0 auto 14px;}'+
      '#moyaki-wallet-sheet h3{font-family:Cinzel,serif;font-weight:800;font-size:16px;letter-spacing:2px;color:#FFD757;text-align:center;margin-bottom:6px;}'+
      '#moyaki-wallet-sheet .sub{font-size:11px;letter-spacing:.5px;color:rgba(243,238,254,.65);text-align:center;margin-bottom:18px;line-height:1.5;}'+
      '#moyaki-wallet-sheet .opt{display:flex;align-items:center;gap:14px;padding:14px 16px;margin-bottom:9px;background:rgba(255,255,255,.04);border:1px solid rgba(255,215,87,.22);border-radius:14px;text-decoration:none;color:#f3eefe;transition:.15s;}'+
      '#moyaki-wallet-sheet .opt:active,#moyaki-wallet-sheet .opt:hover{background:rgba(255,215,87,.12);border-color:rgba(255,215,87,.45);}'+
      '#moyaki-wallet-sheet .opt .ico{width:38px;height:38px;border-radius:10px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;}'+
      '#moyaki-wallet-sheet .opt .meta{flex:1;display:flex;flex-direction:column;gap:2px;}'+
      '#moyaki-wallet-sheet .opt .meta b{font-family:Bungee,system-ui,sans-serif;font-size:13px;letter-spacing:1.5px;color:#fff;font-weight:normal;}'+
      '#moyaki-wallet-sheet .opt .meta small{font-size:10px;color:rgba(243,238,254,.55);letter-spacing:.3px;}'+
      '#moyaki-wallet-sheet .opt .arrow{font-size:18px;opacity:.4;}'+
      '#moyaki-wallet-sheet .closebar{display:block;width:100%;margin-top:10px;padding:13px;background:rgba(255,255,255,.06);color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:11px;font-family:Bungee,system-ui,sans-serif;font-size:11px;letter-spacing:2px;cursor:pointer;}'+
      '#moyaki-wallet-sheet .hint{margin-top:14px;font-size:9.5px;letter-spacing:.5px;color:rgba(243,238,254,.4);text-align:center;line-height:1.6;}';
    document.head.appendChild(s);
  }

  function showSheet(){
    injectStyles();
    var existing = document.getElementById('moyaki-wallet-modal');
    if (existing){ existing.classList.add('show'); return; }
    var d = deeplinks();
    var modal = document.createElement('div');
    modal.id = 'moyaki-wallet-modal';
    modal.innerHTML =
      '<div id="moyaki-wallet-sheet">' +
        '<div class="grip"></div>' +
        '<h3>🐟 OPEN IN A WALLET</h3>' +
        '<div class="sub">Safari can\'t talk to crypto wallets directly.<br>Tap a wallet — it re-opens this page inside it.</div>' +
        '<a class="opt" href="' + d.metamask + '"><span class="ico">🦊</span><span class="meta"><b>MetaMask</b><small>most popular · all EVM wallets</small></span><span class="arrow">→</span></a>' +
        '<a class="opt" href="' + d.rabby    + '"><span class="ico">🐰</span><span class="meta"><b>Rabby</b><small>fastest EVM wallet</small></span><span class="arrow">→</span></a>' +
        '<a class="opt" href="' + d.phantom  + '"><span class="ico">👻</span><span class="meta"><b>Phantom</b><small>solana + EVM</small></span><span class="arrow">→</span></a>' +
        '<a class="opt" href="' + d.trust    + '"><span class="ico">🛡</span><span class="meta"><b>Trust Wallet</b><small>multi-chain</small></span><span class="arrow">→</span></a>' +
        '<button class="closebar" type="button">CLOSE</button>' +
        '<div class="hint">no wallet yet? install MetaMask or Rabby from the App Store, then come back and tap CONNECT.</div>' +
      '</div>';
    document.body.appendChild(modal);
    requestAnimationFrame(function(){ modal.classList.add('show'); });
    modal.querySelector('.closebar').addEventListener('click', hideSheet);
    modal.addEventListener('click', function(e){ if (e.target === modal) hideSheet(); });
  }
  function hideSheet(){
    var m = document.getElementById('moyaki-wallet-modal');
    if (m) m.classList.remove('show');
  }

  window.MoyakiWallet = {
    requireWallet: function(){
      if (isInWalletBrowser()) return true;
      if (isMobile()){ showSheet(); }
      else { alert('No wallet detected.\nInstall MetaMask or Rabby and refresh.'); }
      return false;
    },
    showSheet: showSheet,
    hideSheet: hideSheet,
    isInWalletBrowser: isInWalletBrowser,
    isMobile: isMobile,
  };
})();
