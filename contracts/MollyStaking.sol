// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MollyStaking
/// @notice Stake MOLLY, earn MON. Rewards = % of pool per second, weighted by
///         (amount × lock multiplier). Anyone can fund the pool. Pool never
///         empties — it decays exponentially toward zero.
/// @dev    Single-file. No imports. Designed for clarity + audit-friendliness.

/* ──────────────────────────────────────────────────────────────────────────
   DESIGN SUMMARY

   POOL EMISSION
     Pool decays at DAILY_RATE_BPS (default 100 = 1%/day) compounded continuously.
     Mathematically: pool(t) = pool(0) × e^(-r × t)  where r = ln(1 + DAILY_RATE)/86400
     We use a simpler discrete approximation that converges to the same result:
       Every time _updatePool() runs:
         elapsed = now - lastUpdate
         emission = currentPool × (1 - decayFactor(elapsed))
         accRewardPerWeight += emission * PRECISION / totalWeight
         poolBalance -= emission
     This keeps gas reasonable and is monotonic.

   WEIGHTS
     Each stake position has weight = amount × lockMultiplier / 100.
     Multipliers (per lock days):
       30d  → 100  (1.0x)
       60d  → 150  (1.5x)
       90d  → 200  (2.0x)
       180d → 350  (3.5x)
       365d → 700  (7.0x)
     Custom days linearly interpolate between anchors.

   EARLY UNSTAKE
     Before lockEnd: forfeit ALL pending rewards (stay in pool, increasing
     accRewardPerWeight for remaining stakers), pay 10% penalty of principal:
       60% → 0xdead (burn)
       40% → dev wallet
     User receives 90% of principal back.

   LOCK EXTENSION
     User can extend lockDays on an existing position. New multiplier applies
     to FULL amount immediately. Forfeits no rewards; just upgrades.

   COMPOUND
     User claims MON, then in same tx swaps via whitelisted Monorail router
     to receive MOLLY, then restakes with chosen lock period.
     Router calldata is provided by frontend (built from Monorail quote API).
     We verify token-balance delta to ensure the swap actually delivered MOLLY.

   ADMIN
     Owner can:
       - setPaused(true) to freeze NEW stakes (existing stakes unaffected)
       - setDailyRate (capped at 5%/day so owner can't grief stakers)
       - setMonorailRouter (whitelist update if Monorail changes addresses)
       - setDevWallet (where penalty 40% goes)
     Owner CANNOT:
       - withdraw funds
       - withdraw rewards
       - cancel stakes
       - change multipliers (hardcoded)
       - change penalty splits (hardcoded)
   ────────────────────────────────────────────────────────────────────────── */

interface IERC20 {
    function transfer(address to, uint256 amt) external returns (bool);
    function transferFrom(address from, address to, uint256 amt) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function approve(address spender, uint256 amt) external returns (bool);
}

contract MollyStaking {

    // ─── IMMUTABLES ────────────────────────────────────────────────────────
    IERC20  public immutable MOLLY;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant PRECISION    = 1e18;
    uint256 public constant MIN_LOCK_DAYS = 30;
    uint256 public constant MAX_LOCK_DAYS = 365;
    uint256 public constant PENALTY_BPS = 1000;     // 10% of principal
    uint256 public constant BURN_SPLIT_BPS = 6000;  // 60% of penalty → burn
    uint256 public constant DEV_SPLIT_BPS  = 4000;  // 40% of penalty → dev
    uint256 public constant MAX_DAILY_RATE_BPS = 500; // 5%/day hard cap

    // ─── OWNER/CONFIG ──────────────────────────────────────────────────────
    address public owner;
    address public devWallet;
    address public monorailRouter; // whitelisted target for compound swaps
    bool    public paused;          // freezes new stakes / new funding routes
    uint256 public dailyRateBps;    // basis points, e.g. 100 = 1%/day

    // ─── POOL STATE ────────────────────────────────────────────────────────
    uint256 public poolBalance;            // MON currently in the pool (claimable budget)
    uint256 public totalWeight;            // sum of all active stake weights
    uint256 public accRewardPerWeight;     // accumulator (scaled by PRECISION)
    uint256 public lastUpdateTime;         // last time _updatePool() ran
    uint256 public allTimeDistributed;     // lifetime MON distributed to stakers
    uint256 public allTimeStaked;          // lifetime MOLLY ever staked (never decreases)
    uint256 public activeStakeCount;       // currently-open stake positions across all users

    // ─── PER-USER STATE ────────────────────────────────────────────────────
    struct Stake {
        uint128 amount;       // MOLLY staked (fits 3.4e20, way more than 1B supply)
        uint64  weight;       // amount * multiplier / 100 (rounded down)
        uint32  lockEnd;      // unix seconds (good until 2106)
        uint16  multiplier;   // bps where 100 = 1.0x (max 700)
        uint256 rewardDebt;   // snapshot: weight × accRewardPerWeight at last sync
        uint256 lifetimeClaimed; // MON ever claimed from this position
        bool    open;         // false after closed
    }

    mapping(address => Stake[]) private _stakes;
    mapping(address => uint256) public userTotalWeight;
    mapping(address => uint256) public userLifetimeClaimed;
    mapping(address => uint256) public userLifetimeFunded; // for funder leaderboard

    // ─── EVENTS ────────────────────────────────────────────────────────────
    event Staked(address indexed user, uint256 indexed positionId, uint256 amount, uint256 lockDays, uint256 multiplier, uint256 weight);
    event Unstaked(address indexed user, uint256 indexed positionId, uint256 amountReturned, uint256 rewardsPaid, bool early);
    event LockExtended(address indexed user, uint256 indexed positionId, uint256 newLockEnd, uint256 newMultiplier, uint256 newWeight);
    event Claimed(address indexed user, uint256 indexed positionId, uint256 amount);
    event Funded(address indexed funder, uint256 amount);
    event Compounded(address indexed user, uint256 monIn, uint256 mollyOut, uint256 newLockDays);
    event PoolEmitted(uint256 emission, uint256 newAccRewardPerWeight);
    event PenaltyApplied(address indexed user, uint256 burned, uint256 toDev, uint256 forfeitedRewards);

    // ─── MODIFIERS ─────────────────────────────────────────────────────────
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier notPaused() { require(!paused, "paused"); _; }

    // Reentrancy guard (compact)
    uint256 private _lock = 1;
    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ─── CONSTRUCTOR ───────────────────────────────────────────────────────
    constructor(address mollyToken, address devWallet_, address monorailRouter_) {
        require(mollyToken != address(0), "molly=0");
        require(devWallet_ != address(0), "dev=0");
        MOLLY = IERC20(mollyToken);
        owner = msg.sender;
        devWallet = devWallet_;
        monorailRouter = monorailRouter_; // may be 0 initially; compound disabled until set
        dailyRateBps = 100; // 1%/day default
        lastUpdateTime = block.timestamp;
    }

    // ╔══════════════════════════════════════════════════════════════════════
    // ║ EMISSION MATH
    // ╚══════════════════════════════════════════════════════════════════════

    /// @notice Returns multiplier in bps (100 = 1.0x) for a given lock duration.
    /// @dev Pure function — same lock always returns same multiplier.
    function multiplierFor(uint256 lockDays) public pure returns (uint256) {
        require(lockDays >= MIN_LOCK_DAYS && lockDays <= MAX_LOCK_DAYS, "bad lock");
        if (lockDays <= 30)  return 100;
        if (lockDays <= 60)  return 100 + ((lockDays - 30) * 50) / 30;     // 100→150
        if (lockDays <= 90)  return 150 + ((lockDays - 60) * 50) / 30;     // 150→200
        if (lockDays <= 180) return 200 + ((lockDays - 90) * 150) / 90;    // 200→350
        return 350 + ((lockDays - 180) * 350) / 185;                       // 350→700
    }

    /// @notice Computes the emission since lastUpdateTime, applies it, advances state.
    /// @dev Discrete daily-rate decay applied per-second:
    ///       newPool = oldPool × (1 - ratePerSec)^seconds
    ///      Approximated as oldPool × (1 - elapsed × ratePerSec)  for elapsed << 1day.
    ///      For longer gaps we step daily to keep approximation tight.
    function _updatePool() internal {
        uint256 elapsed = block.timestamp - lastUpdateTime;
        if (elapsed == 0) return;
        lastUpdateTime = block.timestamp;

        if (totalWeight == 0 || poolBalance == 0 || dailyRateBps == 0) {
            // no stakers OR empty pool OR rate=0 → no emission, just advance clock
            return;
        }

        // Compute emission. We step in 1-day chunks max so the linear
        // approximation per chunk stays accurate (<0.01% drift at 1%/day).
        uint256 remaining = elapsed;
        uint256 emission = 0;
        uint256 _pool = poolBalance;

        while (remaining > 0 && _pool > 0) {
            uint256 chunk = remaining > 1 days ? 1 days : remaining;
            // perSecond rate in bps: dailyRateBps / 86400
            // emission in chunk = _pool * dailyRateBps * chunk / (10000 * 86400)
            uint256 chunkEmission = (_pool * dailyRateBps * chunk) / (10_000 * 1 days);
            if (chunkEmission > _pool) chunkEmission = _pool;
            emission += chunkEmission;
            _pool -= chunkEmission;
            remaining -= chunk;
        }

        if (emission > 0) {
            poolBalance = _pool;
            accRewardPerWeight += (emission * PRECISION) / totalWeight;
            allTimeDistributed += emission;
            emit PoolEmitted(emission, accRewardPerWeight);
        }
    }

    /// @notice Returns pending unclaimed MON for a specific stake position.
    /// @dev View function — does NOT update state, simulates _updatePool() first.
    function pendingReward(address user, uint256 positionId) external view returns (uint256) {
        if (positionId >= _stakes[user].length) return 0;
        Stake memory s = _stakes[user][positionId];
        if (!s.open || s.weight == 0) return 0;

        uint256 acc = accRewardPerWeight;
        if (totalWeight > 0 && poolBalance > 0 && dailyRateBps > 0) {
            uint256 elapsed = block.timestamp - lastUpdateTime;
            if (elapsed > 0) {
                // Use the same loop as _updatePool() but only mutate locally
                uint256 remaining = elapsed;
                uint256 emission = 0;
                uint256 _pool = poolBalance;
                while (remaining > 0 && _pool > 0) {
                    uint256 chunk = remaining > 1 days ? 1 days : remaining;
                    uint256 chunkEmission = (_pool * dailyRateBps * chunk) / (10_000 * 1 days);
                    if (chunkEmission > _pool) chunkEmission = _pool;
                    emission += chunkEmission;
                    _pool -= chunkEmission;
                    remaining -= chunk;
                }
                if (emission > 0) acc += (emission * PRECISION) / totalWeight;
            }
        }
        uint256 owed = (uint256(s.weight) * acc) / PRECISION;
        return owed > s.rewardDebt ? owed - s.rewardDebt : 0;
    }

    // ╔══════════════════════════════════════════════════════════════════════
    // ║ STAKING
    // ╚══════════════════════════════════════════════════════════════════════

    /// @notice Stake MOLLY for a chosen lock period.
    /// @param amount MOLLY amount (will be pulled via transferFrom; user must approve first)
    /// @param lockDays 30 to 365
    /// @return positionId index in the user's stakes array
    function stake(uint256 amount, uint256 lockDays) external notPaused nonReentrant returns (uint256 positionId) {
        require(amount > 0, "amount=0");
        _updatePool();

        // Pull tokens — require exact delta to defend against fee-on-transfer tokens
        uint256 balBefore = MOLLY.balanceOf(address(this));
        require(MOLLY.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        uint256 received = MOLLY.balanceOf(address(this)) - balBefore;
        require(received == amount, "fee-on-transfer not supported");

        positionId = _openPosition(msg.sender, amount, lockDays);
    }

    /// @notice Extend the lock on an existing stake. Multiplier upgrades to the
    ///         new lock days. Cannot shorten. Earnings keep accruing seamlessly.
    /// @param positionId index in caller's stakes array
    /// @param newLockDays must be >= current remaining lock (in days) and <= 365
    function extendLock(uint256 positionId, uint256 newLockDays) external nonReentrant {
        Stake storage s = _stakes[msg.sender][positionId];
        require(s.open, "closed");
        require(newLockDays <= MAX_LOCK_DAYS, "max lock");
        // Calculate equivalent "remaining days" — must be at least as long
        uint256 nowTs = block.timestamp;
        uint256 newEnd = nowTs + newLockDays * 1 days;
        require(newEnd > s.lockEnd, "must extend");

        _updatePool();

        // Sync pending into a credit before changing weight
        uint256 owed = (uint256(s.weight) * accRewardPerWeight) / PRECISION;
        uint256 pending = owed > s.rewardDebt ? owed - s.rewardDebt : 0;

        uint256 newMult = multiplierFor(newLockDays);
        require(newMult > s.multiplier, "no upgrade"); // extension only meaningful if mult goes up
        uint256 newWeight = (uint256(s.amount) * newMult) / 100;
        require(newWeight <= type(uint64).max, "weight overflow");

        // Update totals
        totalWeight = totalWeight - s.weight + newWeight;
        userTotalWeight[msg.sender] = userTotalWeight[msg.sender] - s.weight + newWeight;

        s.multiplier = uint16(newMult);
        s.weight = uint64(newWeight);
        s.lockEnd = uint32(newEnd);
        // Reset rewardDebt so pending stays accrued (we re-credit it as if just earned)
        s.rewardDebt = (newWeight * accRewardPerWeight) / PRECISION - pending;

        emit LockExtended(msg.sender, positionId, newEnd, newMult, newWeight);
    }

    /// @notice Claim accumulated MON for a specific stake without unstaking.
    function claim(uint256 positionId) external nonReentrant {
        _claim(msg.sender, positionId);
    }

    function _claim(address user, uint256 positionId) internal returns (uint256 pending) {
        Stake storage s = _stakes[user][positionId];
        require(s.open, "closed");

        _updatePool();

        uint256 owed = (uint256(s.weight) * accRewardPerWeight) / PRECISION;
        pending = owed > s.rewardDebt ? owed - s.rewardDebt : 0;
        if (pending == 0) return 0;

        s.rewardDebt = owed;
        s.lifetimeClaimed += pending;
        userLifetimeClaimed[user] += pending;

        (bool ok, ) = payable(user).call{value: pending}("");
        require(ok, "MON transfer failed");

        emit Claimed(user, positionId, pending);
    }

    /// @notice Unstake a position. After lockEnd → full principal + rewards.
    ///         Before lockEnd → 90% principal back, 10% penalty (60% burn, 40% dev),
    ///         all pending rewards forfeited (stay in pool).
    function unstake(uint256 positionId) external nonReentrant {
        Stake storage s = _stakes[msg.sender][positionId];
        require(s.open, "closed");

        _updatePool();

        uint256 owed = (uint256(s.weight) * accRewardPerWeight) / PRECISION;
        uint256 pending = owed > s.rewardDebt ? owed - s.rewardDebt : 0;

        uint256 weight = s.weight;
        uint256 amount = s.amount;
        bool early = block.timestamp < s.lockEnd;

        // Close the position FIRST (CEI pattern)
        s.open = false;
        s.weight = 0;
        s.rewardDebt = owed;
        totalWeight -= weight;
        userTotalWeight[msg.sender] -= weight;
        activeStakeCount -= 1;

        uint256 toUser;
        uint256 monPayout;

        if (early) {
            // Forfeit pending rewards back to pool
            if (pending > 0 && totalWeight > 0) {
                // Distribute to remaining stakers
                accRewardPerWeight += (pending * PRECISION) / totalWeight;
                allTimeDistributed += pending; // it WILL eventually be distributed
            } else if (pending > 0) {
                // No one left to receive — put back in pool for future stakers
                poolBalance += pending;
                allTimeDistributed -= 0; // already counted as emitted in pool drain; just add to budget
            }

            // 10% penalty: 60% burn, 40% dev
            uint256 penalty = (amount * PENALTY_BPS) / 10_000;
            uint256 burnAmt = (penalty * BURN_SPLIT_BPS) / 10_000;
            uint256 devAmt  = penalty - burnAmt;
            toUser = amount - penalty;

            require(MOLLY.transfer(BURN_ADDRESS, burnAmt), "burn xfer failed");
            require(MOLLY.transfer(devWallet, devAmt), "dev xfer failed");
            require(MOLLY.transfer(msg.sender, toUser), "user xfer failed");

            emit PenaltyApplied(msg.sender, burnAmt, devAmt, pending);
            emit Unstaked(msg.sender, positionId, toUser, 0, true);
            monPayout = 0;
        } else {
            // Lock expired — pay full principal + rewards
            toUser = amount;
            require(MOLLY.transfer(msg.sender, amount), "user xfer failed");

            if (pending > 0) {
                s.lifetimeClaimed += pending;
                userLifetimeClaimed[msg.sender] += pending;
                (bool ok, ) = payable(msg.sender).call{value: pending}("");
                require(ok, "MON transfer failed");
                monPayout = pending;
            }

            emit Unstaked(msg.sender, positionId, amount, pending, false);
        }
    }

    // ╔══════════════════════════════════════════════════════════════════════
    // ║ COMPOUND (claim MON → swap to MOLLY via Monorail → restake)
    // ╚══════════════════════════════════════════════════════════════════════

    /// @notice Claim pending MON from one stake, swap it for MOLLY via the
    ///         whitelisted Monorail router, then create a new staking position.
    /// @param positionId stake to claim from
    /// @param newLockDays lock period for the new compounded position
    /// @param monorailCalldata raw calldata to send to the Monorail router
    ///         (frontend obtains this from Monorail quote API; must produce a swap
    ///          that delivers MOLLY to address(this))
    /// @param minMollyOut minimum MOLLY expected (frontend computes from quote)
    function compound(
        uint256 positionId,
        uint256 newLockDays,
        bytes calldata monorailCalldata,
        uint256 minMollyOut
    ) external nonReentrant notPaused returns (uint256 newPositionId) {
        require(monorailRouter != address(0), "compound disabled");
        require(minMollyOut > 0, "minOut=0");

        uint256 pending = _claimToContract(positionId);
        require(pending > 0, "nothing to compound");

        uint256 mollyOut = _swapMonForMolly(pending, monorailCalldata, minMollyOut);
        newPositionId = _openPosition(msg.sender, mollyOut, newLockDays);
        emit Compounded(msg.sender, pending, mollyOut, newLockDays);
    }

    /// @dev Internal helper — marks pending claimed but does NOT pay out.
    ///      Used by compound() so the MON stays in the contract for the swap.
    function _claimToContract(uint256 positionId) internal returns (uint256 pending) {
        Stake storage s = _stakes[msg.sender][positionId];
        require(s.open, "closed");
        _updatePool();
        uint256 owed = (uint256(s.weight) * accRewardPerWeight) / PRECISION;
        pending = owed > s.rewardDebt ? owed - s.rewardDebt : 0;
        if (pending == 0) return 0;
        s.rewardDebt = owed;
        s.lifetimeClaimed += pending;
        userLifetimeClaimed[msg.sender] += pending;
    }

    /// @dev Internal helper — performs the Monorail swap, verifies output.
    function _swapMonForMolly(
        uint256 monIn,
        bytes calldata monorailCalldata,
        uint256 minMollyOut
    ) internal returns (uint256 mollyOut) {
        uint256 mollyBefore = MOLLY.balanceOf(address(this));
        (bool ok, bytes memory ret) = monorailRouter.call{value: monIn}(monorailCalldata);
        if (!ok) {
            if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
            revert("monorail swap failed");
        }
        mollyOut = MOLLY.balanceOf(address(this)) - mollyBefore;
        require(mollyOut >= minMollyOut, "slippage");
    }

    /// @dev Internal helper — creates a new stake position for `user` with
    ///      tokens already in the contract. Used by stake() (after pull) and
    ///      compound() (after swap).
    function _openPosition(
        address user,
        uint256 amount,
        uint256 lockDays
    ) internal returns (uint256 positionId) {
        uint256 mult = multiplierFor(lockDays);
        uint256 weight = (amount * mult) / 100;
        require(weight > 0, "weight=0");
        require(weight <= type(uint64).max, "weight overflow");
        require(amount <= type(uint128).max, "amount overflow");
        uint256 lockEndTs = block.timestamp + lockDays * 1 days;
        require(lockEndTs <= type(uint32).max, "lockEnd overflow");

        positionId = _stakes[user].length;
        _stakes[user].push(Stake({
            amount: uint128(amount),
            weight: uint64(weight),
            lockEnd: uint32(lockEndTs),
            multiplier: uint16(mult),
            rewardDebt: (weight * accRewardPerWeight) / PRECISION,
            lifetimeClaimed: 0,
            open: true
        }));

        totalWeight += weight;
        userTotalWeight[user] += weight;
        allTimeStaked += amount;
        activeStakeCount += 1;

        emit Staked(user, positionId, amount, lockDays, mult, weight);
    }

    // ╔══════════════════════════════════════════════════════════════════════
    // ║ FUNDING (anyone can send MON to grow the pool)
    // ╚══════════════════════════════════════════════════════════════════════

    /// @notice Send MON to grow the reward pool. Anyone may call.
    function fundRewards() external payable {
        _fund(msg.sender, msg.value);
    }

    /// @notice Fallback: plain MON transfers also fund the pool.
    receive() external payable {
        _fund(msg.sender, msg.value);
    }

    function _fund(address from, uint256 amount) internal {
        require(amount > 0, "amount=0");
        _updatePool();
        poolBalance += amount;
        userLifetimeFunded[from] += amount;
        emit Funded(from, amount);
    }

    // ╔══════════════════════════════════════════════════════════════════════
    // ║ VIEWS (for the UI's "hella visuals")
    // ╚══════════════════════════════════════════════════════════════════════

    function stakeCountOf(address user) external view returns (uint256) {
        return _stakes[user].length;
    }

    function stakeAt(address user, uint256 positionId) external view returns (
        uint256 amount,
        uint256 weight,
        uint256 lockEnd,
        uint256 multiplier,
        uint256 lifetimeClaimed_,
        bool open
    ) {
        Stake memory s = _stakes[user][positionId];
        return (s.amount, s.weight, s.lockEnd, s.multiplier, s.lifetimeClaimed, s.open);
    }

    /// @notice One-call read of pool-wide stats.
    function poolStats() external view returns (
        uint256 _poolBalance,
        uint256 _totalWeight,
        uint256 _activeStakes,
        uint256 _allTimeDistributed,
        uint256 _allTimeStaked,
        uint256 _dailyRateBps
    ) {
        return (poolBalance, totalWeight, activeStakeCount, allTimeDistributed, allTimeStaked, dailyRateBps);
    }

    /// @notice One-call read of user-specific stats.
    function userStats(address user) external view returns (
        uint256 _userWeight,
        uint256 _userPositions,
        uint256 _userLifetimeClaimed,
        uint256 _userLifetimeFunded
    ) {
        return (
            userTotalWeight[user],
            _stakes[user].length,
            userLifetimeClaimed[user],
            userLifetimeFunded[user]
        );
    }

    // ╔══════════════════════════════════════════════════════════════════════
    // ║ ADMIN (intentionally limited)
    // ╚══════════════════════════════════════════════════════════════════════

    function setPaused(bool p) external onlyOwner { paused = p; }

    function setDailyRate(uint256 bps) external onlyOwner {
        require(bps <= MAX_DAILY_RATE_BPS, "too high");
        _updatePool(); // settle at old rate before switching
        dailyRateBps = bps;
    }

    function setMonorailRouter(address r) external onlyOwner {
        monorailRouter = r; // may set to 0 to disable compound entirely
    }

    function setDevWallet(address w) external onlyOwner {
        require(w != address(0), "zero");
        devWallet = w;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        owner = newOwner;
    }

    /// @notice Owner can sweep tokens that were accidentally sent to this contract,
    ///         EXCLUDING MOLLY (staked) and MON (pool). Defense against support spam,
    ///         not a backdoor.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(MOLLY), "no rescue MOLLY");
        require(to != address(0), "zero");
        require(IERC20(token).transfer(to, amount), "rescue failed");
    }
}
