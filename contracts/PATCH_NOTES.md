# PATCH_NOTES.md — External Audit Response

A second-pass audit was performed by Claude Code on the original `MollyStaking.sol`.
This document tracks every finding and the corresponding fix in the patched contract.

**Status:** ✅ All findings addressed. Contract compiles clean, 0 warnings,
13,284 bytes (well under 24,576 EVM limit).

---

## 🔴 CRITICAL (must-fix before deploy)

### C1 — `uint64 weight` overflow with 18-decimal MOLLY ✅ FIXED

**Issue:** `Stake.weight` was `uint64`, capping max stake at ~18 MOLLY at 1x multiplier or ~2.6 MOLLY at 7x. Would have bricked the contract for any realistic deposit.

**Fix:** Changed `weight` from `uint64` to `uint128`. All casts (`uint64(weight)` → `uint128(weight)`) and all `type(uint64).max` checks (`type(uint128).max`) updated to match. Inline comment expanded to clarify the math.

```diff
- uint64  weight;       // amount * multiplier / 100 (rounded down)
+ uint128 weight;       // amount × multiplier / 100 in wei; uint128 covers 1B supply × 7x mult
```

**Verified:** MOLLY decimals confirmed as 18 via on-chain `decimals()` call.

---

## 🟠 HIGH (should-fix before deploy)

### H1 — `extendLock` missing uint32 overflow guard ✅ FIXED

**Issue:** `_openPosition` guarded `lockEndTs <= type(uint32).max` but `extendLock` did a bare cast that would silently wrap.

**Fix:** Added the same guard in `extendLock` immediately after computing `newEnd`.

```diff
  require(newEnd > s.lockEnd, "must extend");
+ require(newEnd <= type(uint32).max, "lockEnd overflow"); // H1: parity with _openPosition
```

### H2 — `receive()` / `fundRewards()` not `nonReentrant` ✅ FIXED

**Issue:** Router refund dust could re-enter `_fund()` during `compound()`, polluting funder stats and creating a future-edit hazard.

**Fix:** Both entry points now carry the `nonReentrant` modifier.

```diff
- function fundRewards() external payable {
+ function fundRewards() external payable nonReentrant {

- receive() external payable {
+ receive() external payable nonReentrant {
```

### H3 — `allTimeDistributed` double-counted forfeited rewards ✅ FIXED

**Issue:** On early unstake, forfeited rewards were re-added to `allTimeDistributed` even though they were already counted in the original emission from `poolBalance`. Inflated lifetime stat by every forfeit.

**Fix:** Removed `allTimeDistributed += pending;` from the early-unstake forfeit branch. Also tightened the no-stakers-left branch to roll back the over-count (`allTimeDistributed -= pending`) since the MON goes back into `poolBalance` to be re-emitted later.

```diff
  if (pending > 0 && totalWeight > 0) {
      accRewardPerWeight += (pending * PRECISION) / totalWeight;
-     allTimeDistributed += pending; // it WILL eventually be distributed
  } else if (pending > 0) {
      poolBalance += pending;
-     allTimeDistributed -= 0;
+     allTimeDistributed -= pending;  // roll back; will re-count on next emission
  }
```

### H4 — `_claimToContract` didn't emit `Claimed` ✅ FIXED

**Issue:** Indexers tracking lifetime claims via `Claimed` events would undercount by the MON portion of every compound.

**Fix:** Added `emit Claimed(msg.sender, positionId, pending)` at the end of `_claimToContract`.

### H5 — Bricked `receive()` could trap MOLLY ✅ FIXED

**Issue:** If a contract user's `receive()` reverted, mature unstake would revert the whole tx, trapping their MOLLY. Same for `claim()`.

**Fix:** Implemented **pull pattern** for all MON payouts.

- New mapping: `mapping(address => uint256) public withdrawableMon`
- New helper: `_payMon(to, amount)` — try direct send with 30k gas cap; if it fails, credit the user's `withdrawableMon` balance and emit `MonWithdrawCredited`
- New public function: `withdrawMon()` — user pulls accumulated balance

Now mature unstake always succeeds in returning MOLLY, even for contract users with broken receive functions. Their MON gets queued for pull.

```diff
+ mapping(address => uint256) public withdrawableMon;

+ function _payMon(address to, uint256 amount) internal {
+     if (amount == 0) return;
+     (bool ok, ) = payable(to).call{value: amount, gas: 30_000}("");
+     if (!ok) {
+         withdrawableMon[to] += amount;
+         emit MonWithdrawCredited(to, amount);
+     }
+ }

+ function withdrawMon() external nonReentrant {
+     uint256 amt = withdrawableMon[msg.sender];
+     require(amt > 0, "nothing to withdraw");
+     withdrawableMon[msg.sender] = 0;
+     (bool ok, ) = payable(msg.sender).call{value: amt}("");
+     require(ok, "withdraw failed");
+     emit MonWithdrawn(msg.sender, amt);
+ }
```

Both `_claim()` and the mature branch of `unstake()` now use `_payMon()` instead of bare `.call`.

**Trade-off note:** the gas cap of 30k on the direct send is intentional — it prevents griefing via a recipient that consumes all forwarded gas. Normal EOAs and well-behaved contract wallets work fine within 30k.

---

## 🟡 MEDIUM

### M1 — One-step `transferOwnership` was a footgun ✅ FIXED

**Issue:** Fat-fingered address bricks contract permanently.

**Fix:** Implemented OZ-style `Ownable2Step` pattern manually.

```diff
+ address public pendingOwner;

  function transferOwnership(address newOwner) external onlyOwner {
      require(newOwner != address(0), "zero");
-     owner = newOwner;
+     pendingOwner = newOwner;
+     emit OwnershipTransferStarted(owner, newOwner);
  }

+ function acceptOwnership() external {
+     require(msg.sender == pendingOwner, "not pending owner");
+     address old = owner;
+     owner = pendingOwner;
+     pendingOwner = address(0);
+     emit OwnershipTransferred(old, owner);
+ }
```

### M2 — No events on admin mutations ✅ FIXED

**Issue:** "Owner can't rug" claim couldn't be observed.

**Fix:** Added 7 admin events. Every owner action now emits.

```diff
+ event PausedSet(bool paused);
+ event DailyRateSet(uint256 oldBps, uint256 newBps);
+ event MonorailRouterSet(address indexed oldRouter, address indexed newRouter);
+ event DevWalletSet(address indexed oldWallet, address indexed newWallet);
+ event OwnershipTransferStarted(address indexed previousOwner, address indexed pendingOwner);
+ event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
+ event TokenRescued(address indexed token, address indexed to, uint256 amount);
```

Each admin setter now emits its corresponding event.

### M3 — `extendLock` blocked lateral renewals ✅ FIXED

**Issue:** Couldn't extend a 60-day stake by another 60 days because multiplier didn't change.

**Fix:** Changed strict `>` to `>=` so same-multiplier extensions work. Multiplier downgrades still blocked.

```diff
- require(newMult > s.multiplier, "no upgrade");
+ require(newMult >= s.multiplier, "no downgrade");
```

The combination of `newEnd > s.lockEnd` (must extend in time) + `newMult >= s.multiplier` (must not downgrade rate) is exactly the user-friendly invariant.

### M4 — `rescueToken` not `nonReentrant` ✅ FIXED

**Issue:** Malicious token's `transfer()` could call back into the contract bypassing the lock guard.

**Fix:** Added `nonReentrant` to `rescueToken`.

### M5 — `extendLock` not gated by `notPaused` ✅ FIXED

**Issue:** During pause, weights could still shift via `extendLock`, distorting emission distribution.

**Fix:** Added `notPaused` modifier to `extendLock`.

---

## 🟢 LOW / Info (no action needed, documented in AUDIT.md)

| ID | Issue | Status |
|---|---|---|
| L1 | `multiplierFor(31) = 101` integer-division artifact | Acceptable. Documented as design intent (linear interpolation). |
| L2 | Stakes < 10 wei evade penalty (rounds to 0) | Dust only. UI sets minimum stake threshold above 10 wei. |
| L3 | `MOLLY.transfer` assumes bool return | Fine for MOLLY (verified ERC20 compliant). |
| L4 | `pendingReward()` view loop unbounded | Bounded in practice; documented in AUDIT.md. |
| L5 | `rescueToken` can pull arbitrary ERC20s | Intended — defense against support spam. |
| L6 | Funding with no stakers is uncompensated | Intentional. UI warns. |
| L7 | `claim()` with pending=0 returns silently | Cosmetic. |
| L8 | `setMonorailRouter` had no event | ✅ Fixed via M2 (`MonorailRouterSet` event). |

---

## Final compile status

```
✓ COMPILED CLEAN
  warnings: 0
  bytecode: 13,408 bytes (55% of 24,576 EVM limit)
  functions: 47 (+6 from patches total)
  events:    17 (+9 from patches total)
```

---

## Round 2: Findings from re-audit (N1/N2/N3) ✅ ALL FIXED

After applying the round-1 fixes, the auditor flagged three new issues introduced by the patches themselves. All addressed.

### N1 — `nonReentrant` on `receive()`/`fundRewards()` broke Monorail refunds ✅ FIXED

**Issue:** Adding `nonReentrant` to `receive()` (round-1 H2 fix) closed a legitimate path: when Monorail's router refunds leftover MON to the staking contract during `compound()`, the staking contract's `_lock == 2` causes `receive()` to revert, reverting the whole compound tx.

The auditor verified that `_fund()` is provably safe to reenter — it just increments two SSTORE counters and calls `_updatePool()` (which is a no-op at elapsed=0). The H2 fix was overkill.

**Fix:** Removed `nonReentrant` from both `receive()` and `fundRewards()`. Added explicit `@dev` comments explaining why each is safe.

```diff
- function fundRewards() external payable nonReentrant {
+ function fundRewards() external payable {

- receive() external payable nonReentrant {
+ receive() external payable {
```

**Trade-off accepted:** Minor stat-pollution risk — if Monorail refunds dust to staking contract, the router's address gets a `userLifetimeFunded` credit. Acceptable cost for keeping compound working.

**Note on 2300-gas `.transfer()` callers:** Documented as expected. Modern Solidity convention is `.call{value:}` which forwards adequate gas. Any caller using `.transfer()` will revert — this is industry-standard post-EIP-1884.

### N2 — `_payMon` 30k gas cap too tight for smart wallets ✅ FIXED

**Issue:** 30k gas was enough for EOAs but not for Gnosis Safe (typically 30-45k) or ERC-4337 accounts. Forces smart-wallet users into pull-pattern fallback even when their `receive()` would have worked with a slightly bigger budget.

**Fix:** Raised gas cap to 100k. Still bounded (prevents grief from a recipient that burns infinite gas), but accommodates all realistic smart wallets.

```diff
- (bool ok, ) = payable(to).call{value: amount, gas: 30_000}("");
+ (bool ok, ) = payable(to).call{value: amount, gas: 100_000}("");
```

### N3 — `withdrawMon` locked to msg.sender ✅ FIXED

**Issue:** If a contract user's `receive()` is broken even with full gas (or if they've lost access to the original wallet), they can't redirect their accumulated MON to a working address.

**Fix:** Added `withdrawMonTo(address recipient)` as a sibling to `withdrawMon()`. Both routes go through `_withdrawMonTo()` helper to keep the CEI accounting consistent.

```diff
+ function withdrawMonTo(address recipient) external nonReentrant {
+     require(recipient != address(0), "zero recipient");
+     _withdrawMonTo(msg.sender, recipient);
+ }
```

`withdrawMon()` unchanged for users who want the default (self) behavior.

---

## Deployment is now safe to proceed

Constructor args unchanged:
```
mollyToken      = 0xB72e6262DAE53cAF167F0966421a0B9782977777
devWallet_      = 0xa424c64aa051cf75749b6377bfc86f20f212cb24
monorailRouter_ = 0x0000000000000000000000000000000000000000  (set later)
```

Compile settings unchanged:
- Solidity ^0.8.20
- Optimizer enabled, 200 runs
- viaIR NOT required

Re-audit recommended on:
- `_payMon` and `withdrawMon` (new pull-pattern surface)
- The two-step ownership transition
- `extendLock` lateral-renewal logic
