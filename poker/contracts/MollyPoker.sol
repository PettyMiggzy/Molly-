// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*
   __  ___   __  __         ___       _
  /  |/  /__/ / / /_ __    / _ \___  / /_____ ____
 / /|_/ / _ / // / // /   / ___/ _ \/  '_/ -_) __/
/_/  /_/\_,_/\_,_/\_, /   /_/   \___/_/\_\\__/_/
                 /___/
                 v2 — POST-AUDIT REWRITE

  Fixes from the Claude Code audit pass:

    C1/H1 — fold no longer mutates the players array.
             folded[] flag carries through every round.
             _nextActiveTurn skips folded seats.
    C2    — last-active player must have acted before any
             round transitions (including round 3 -> showdown).
    C3    — seated[tableId][addr] mapping prevents one wallet
             from taking multiple seats at the same table.
    C4    — leaveTable() + cashOutBusted() + dealCards refuses
             to deal if any player has chips < bigBlind.
    H2    — withdrawAsWMON and non-MOLLY showdown require
             _swapMinOut > 0 (sandwich protection).
    H3    — buyIn measures balance delta on transferFrom so
             fee-on-transfer tokens can't leave the contract
             token-insolvent.
    H4    — withdrawChips / withdrawAsWMON / leaveTable /
             cashOutBusted all require table.state == Inactive.
    H5    — playHand is nonReentrant.
    M2    — setSwapRouter requires non-zero argument to be a
             contract (extcodesize > 0).
    M3    — setPoolFee accepts 0 (reset to default).
    M4    — emergencyRefund clears seated[] + table.players
             and resets table state when the table empties.
    M5    — swap deadline = block.timestamp (atomic tx).
    M6    — _reInitiateTable wipes all 4 round slots.
    L1    — dealCards rejects zero card hashes.
    L2    — dealCommunityCards requires roundId == currentRound.
    L4    — LAST_ROUND constant instead of hardcoded 3.

  Trust model unchanged: dealer (owner) commits hashes, reveals
  at showdown, declares the winner. Contract verifies the
  commit-reveal and enforces the money rails (70/20/10 for MOLLY,
  70/30 with auto-swap-to-WMON for everything else).
*/

import {IERC20}           from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}        from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable}          from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard}  from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISwapRouterV3 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

contract MollyPoker is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ---------- types ---------- */

    enum TableState   { Active, Inactive, Showdown }
    enum PlayerAction { Call,   Raise,    Check,    Fold }

    struct Table {
        TableState state;
        uint totalHands;
        uint currentRound;
        uint buyInAmount;
        uint maxPlayers;
        address[] players;
        uint pot;
        uint bigBlind;
        IERC20 token;
        address creator;
    }
    struct Round {
        bool state;
        uint turn;
        address[] players;
        uint highestChip;
        uint[] chips;
        bool[] folded; // NEW (C1/H1)
        uint actsSinceReset; // NEW — counts actions in the current betting cycle; resets on Raise
    }
    struct PlayerCardHashes { bytes32 card1Hash; bytes32 card2Hash; }
    struct PlayerCards      { uint8 card1;       uint8 card2; }

    /* ---------- events ---------- */
    event NewTableCreated(uint indexed tableId, address indexed creator, address indexed token, uint buyIn, uint bigBlind);
    event NewBuyIn(uint indexed tableId, address indexed player, uint amount, uint received);
    event Withdrawn(uint indexed tableId, address indexed player, address indexed token, uint amount);
    event WithdrawnAsWMON(uint indexed tableId, address indexed player, address tokenIn, uint amountIn, uint wmonOut);
    event LeftTable(uint indexed tableId, address indexed player);
    event AutoCashOut(uint indexed tableId, address indexed player, uint amount);
    event CardsDealt(uint indexed tableId, uint handNum, PlayerCardHashes[] cardHashes);
    event ActionTaken(uint indexed tableId, uint roundId, address indexed player, PlayerAction action, uint amount);
    event RoundOver(uint indexed tableId, uint roundId);
    event CommunityCardsDealt(uint indexed tableId, uint roundId, uint8[] cards);
    event ShowdownStarted(uint indexed tableId, uint handNum);
    event CardsRevealed(uint indexed tableId, uint indexed handNum, address[] players, PlayerCards[] cards, uint8[] community, bool[] folded);
    event PotDistributed(
        uint indexed tableId,
        uint indexed handNum,
        address indexed winner,
        address tableToken,
        uint winnerAmount,
        uint burnAmount,
        uint devAmount,
        uint wmonRakeOut
    );
    event EmergencyRefund(uint indexed tableId, address indexed player, uint amount);
    event WhitelistedCreatorUpdated(address indexed creator, bool whitelisted);
    event MollyHoldRequiredUpdated(uint oldValue, uint newValue);
    event SwapRouterUpdated(address indexed oldRouter, address indexed newRouter);
    event PoolFeeUpdated(address indexed token, uint24 fee);
    event RakeSwapFailed(uint indexed tableId, address indexed token, uint amount, string reason);

    /* ---------- constants ---------- */
    uint16 public constant WINNER_BPS = 7000;
    uint16 public constant BURN_BPS   = 2000;
    uint16 public constant DEV_BPS    = 1000;
    uint16 public constant RAKE_BPS   = 3000;
    uint16 public constant BPS        = 10_000;
    uint8  public constant LAST_ROUND = 3; // L4 — preflop / flop / turn / river

    uint24  public constant DEFAULT_POOL_FEE = 10_000;

    /* ---------- immutable ---------- */
    address public immutable BURN_ADDR;
    address public immutable DEV_ADDR;
    address public immutable MOLLY_TOKEN;
    address public immutable WMON;

    /* ---------- mutable config ---------- */
    address public swapRouter;
    uint    public mollyHoldRequired = 100_000 ether;
    mapping(address => bool)   public whitelistedCreator;
    mapping(address => uint24) public poolFee;

    /* ---------- state ---------- */
    uint public totalTables;
    mapping(uint => Table) public tables;
    mapping(address => mapping(uint => uint)) public chips;
    mapping(address => mapping(uint => mapping(uint => PlayerCardHashes))) public playerHashes;
    mapping(uint => mapping(uint => Round)) public rounds;
    mapping(uint => uint8[]) public communityCards;

    // C3 — prevents one wallet from taking multiple seats at a table
    mapping(uint => mapping(address => bool)) public seated;

    /* ---------- modifiers ---------- */
    modifier onlyWhitelistedOrOwner() {
        require(whitelistedCreator[msg.sender] || msg.sender == owner(), "not authorized");
        _;
    }

    /* ---------- constructor ---------- */
    constructor(
        address _burnAddr,
        address _devAddr,
        address _mollyToken,
        address _wmon,
        address _swapRouter
    ) Ownable(msg.sender) {
        require(_burnAddr   != address(0), "burn=0");
        require(_devAddr    != address(0), "dev=0");
        require(_mollyToken != address(0), "molly=0");
        require(_wmon       != address(0), "wmon=0");
        require(WINNER_BPS + BURN_BPS + DEV_BPS == BPS, "molly bps != 10000");
        require(WINNER_BPS + RAKE_BPS == BPS, "nonmolly bps != 10000");
        BURN_ADDR   = _burnAddr;
        DEV_ADDR    = _devAddr;
        MOLLY_TOKEN = _mollyToken;
        WMON        = _wmon;
        swapRouter  = _swapRouter;
    }

    /* ============================================================
       ADMIN
       ============================================================ */
    function setWhitelistedCreator(address _creator, bool _whitelisted) external onlyOwner {
        whitelistedCreator[_creator] = _whitelisted;
        emit WhitelistedCreatorUpdated(_creator, _whitelisted);
    }
    function setMollyHoldRequired(uint _amount) external onlyOwner {
        uint old = mollyHoldRequired;
        mollyHoldRequired = _amount;
        emit MollyHoldRequiredUpdated(old, _amount);
    }
    function setSwapRouter(address _router) external onlyOwner {
        // M2 — non-zero router must be a contract
        // P4 L1 — but it can't be THIS contract (would cause a self-loop swap)
        if (_router != address(0)) {
            require(_router != address(this), "router=self");
            uint size;
            assembly { size := extcodesize(_router) }
            require(size > 0, "router not contract");
        }
        address old = swapRouter;
        swapRouter = _router;
        emit SwapRouterUpdated(old, _router);
    }
    function setPoolFee(address _token, uint24 _fee) external onlyOwner {
        // M3 — 0 resets to default
        require(_fee == 0 || _fee == 100 || _fee == 500 || _fee == 3000 || _fee == 10000, "bad fee");
        poolFee[_token] = _fee;
        emit PoolFeeUpdated(_token, _fee);
    }

    /* ============================================================
       PLAYER ACTIONS
       ============================================================ */
    function createTable(
        uint _buyInAmount,
        uint _maxPlayers,
        uint _bigBlind,
        address _token
    ) external onlyWhitelistedOrOwner {
        require(_token != address(0), "token=0");
        require(_maxPlayers >= 2 && _maxPlayers <= 9, "bad maxPlayers");
        require(_bigBlind > 0, "bb=0");
        require(_buyInAmount >= _bigBlind, "buyIn < bb");
        address[] memory empty;
        tables[totalTables] = Table({
            state: TableState.Inactive,
            totalHands: 0,
            currentRound: 0,
            buyInAmount: _buyInAmount,
            maxPlayers: _maxPlayers,
            players: empty,
            pot: 0,
            bigBlind: _bigBlind,
            token: IERC20(_token),
            creator: msg.sender
        });
        emit NewTableCreated(totalTables, msg.sender, _token, _buyInAmount, _bigBlind);
        totalTables += 1;
    }

    function buyIn(uint _tableId, uint _amount) external nonReentrant {
        require(
            IERC20(MOLLY_TOKEN).balanceOf(msg.sender) >= mollyHoldRequired,
            "need 100k MOLLY"
        );
        Table storage table = tables[_tableId];
        // C3 — no double-seating
        require(!seated[_tableId][msg.sender], "already seated");
        require(table.state == TableState.Inactive, "table in hand");
        require(_amount >= table.buyInAmount, "Not enough buyInAmount");
        require(table.players.length < table.maxPlayers, "Table full");

        // H3 — measure actual delta so fee-on-transfer tokens can't leave us insolvent
        uint balBefore = table.token.balanceOf(address(this));
        table.token.safeTransferFrom(msg.sender, address(this), _amount);
        uint received = table.token.balanceOf(address(this)) - balBefore;
        require(received >= table.buyInAmount, "transfer short (fee-on-transfer?)");

        chips[msg.sender][_tableId] += received;
        table.players.push(msg.sender);
        seated[_tableId][msg.sender] = true;

        emit NewBuyIn(_tableId, msg.sender, _amount, received);
    }

    function withdrawChips(uint _amount, uint _tableId) external nonReentrant {
        Table storage table = tables[_tableId];
        require(table.state == TableState.Inactive, "table active"); // H4
        require(chips[msg.sender][_tableId] >= _amount, "Not enough balance");
        chips[msg.sender][_tableId] -= _amount;
        IERC20(address(table.token)).safeTransfer(msg.sender, _amount);
        emit Withdrawn(_tableId, msg.sender, address(table.token), _amount);
    }

    function withdrawAsWMON(uint _amount, uint _tableId, uint _minWmonOut) external nonReentrant {
        Table storage table = tables[_tableId];
        require(table.state == TableState.Inactive, "table active");      // H4
        require(address(table.token) != MOLLY_TOKEN, "use withdrawChips for MOLLY");
        require(chips[msg.sender][_tableId] >= _amount, "Not enough balance");
        require(swapRouter != address(0), "no router");
        require(_minWmonOut > 0, "minOut=0");                              // H2

        chips[msg.sender][_tableId] -= _amount;

        uint wmonOut = _swapToWMON(address(table.token), _amount, _minWmonOut);
        IERC20(WMON).safeTransfer(msg.sender, wmonOut);
        emit WithdrawnAsWMON(_tableId, msg.sender, address(table.token), _amount, wmonOut);
    }

    /// C4 — voluntary exit (only between hands)
    function leaveTable(uint _tableId) external nonReentrant {
        Table storage table = tables[_tableId];
        require(table.state == TableState.Inactive, "table active");
        require(seated[_tableId][msg.sender], "not seated");

        uint amt = chips[msg.sender][_tableId];
        if (amt > 0) {
            chips[msg.sender][_tableId] = 0;
            table.token.safeTransfer(msg.sender, amt);
            emit Withdrawn(_tableId, msg.sender, address(table.token), amt);
        }
        _removeFromPlayers(table.players, msg.sender);
        seated[_tableId][msg.sender] = false;
        emit LeftTable(_tableId, msg.sender);
    }

    /// C4 — anyone can cash out players whose chips < bigBlind. Dealer node
    ///      should call this before each new dealCards.
    function cashOutBusted(uint _tableId) external nonReentrant {
        Table storage table = tables[_tableId];
        require(table.state == TableState.Inactive, "table active");
        uint i = 0;
        while (i < table.players.length) {
            address p = table.players[i];
            uint amt = chips[p][_tableId];
            if (amt < table.bigBlind) {
                if (amt > 0) {
                    chips[p][_tableId] = 0;
                    table.token.safeTransfer(p, amt);
                }
                seated[_tableId][p] = false;
                // safe swap-and-pop — table is idle, no turn invariants to preserve
                uint last = table.players.length - 1;
                if (i != last) table.players[i] = table.players[last];
                table.players.pop();
                emit AutoCashOut(_tableId, p, amt);
                // don't increment i; swap brought a different player here
            } else {
                i++;
            }
        }
    }

    function playHand(uint _tableId, PlayerAction _action, uint _raiseAmount)
        external
        nonReentrant // H5
    {
        Table storage table = tables[_tableId];
        require(table.state == TableState.Active, "No Active Round");

        Round storage round = rounds[_tableId][table.currentRound];
        require(round.players[round.turn] == msg.sender, "Not your turn");
        require(!round.folded[round.turn], "already folded");

        uint amountForEvent = 0;

        if (_action == PlayerAction.Call) {
            uint callAmount = round.highestChip - round.chips[round.turn];
            require(chips[msg.sender][_tableId] >= callAmount, "no chips");
            chips[msg.sender][_tableId] -= callAmount;
            round.chips[round.turn] += callAmount;
            table.pot += callAmount;
            amountForEvent = callAmount;
            round.actsSinceReset += 1;

        } else if (_action == PlayerAction.Check) {
            // Only allowed if your own bet matches the highest (i.e., no one outbid you)
            require(round.chips[round.turn] == round.highestChip, "Check not possible");
            round.actsSinceReset += 1;

        } else if (_action == PlayerAction.Raise) {
            uint totalAmount = _raiseAmount + round.chips[round.turn];
            require(totalAmount > round.highestChip, "Raise amount not enough");
            require(chips[msg.sender][_tableId] >= _raiseAmount, "no chips");
            chips[msg.sender][_tableId] -= _raiseAmount;
            round.chips[round.turn] += _raiseAmount;
            table.pot += _raiseAmount;
            round.highestChip = totalAmount;
            amountForEvent = _raiseAmount;
            round.actsSinceReset = 1; // raise resets the cycle — everyone else needs another turn

        } else if (_action == PlayerAction.Fold) {
            // C1/H1 — flag instead of mutating the players array
            round.folded[round.turn] = true;
            round.actsSinceReset += 1;
        }

        emit ActionTaken(_tableId, table.currentRound, msg.sender, _action, amountForEvent);
        _finishRound(_tableId, table);
    }

    /* ============================================================
       DEALER NODE (owner)
       ============================================================ */
    function dealCards(PlayerCardHashes[] memory _playerCards, uint _tableId) external onlyOwner {
        Table storage table = tables[_tableId];
        uint n = table.players.length;
        require(table.state == TableState.Inactive, "Game already going on");
        require(n > 1 && _playerCards.length == n, "ERROR: PlayerCardHashes Length");

        // C4 — refuse to deal to anyone who can't post BB
        for (uint i = 0; i < n; i++) {
            require(chips[table.players[i]][_tableId] >= table.bigBlind, "player undercapitalized");
            // L1 — non-zero hashes
            require(_playerCards[i].card1Hash != bytes32(0), "zero hash");
            require(_playerCards[i].card2Hash != bytes32(0), "zero hash");
        }

        table.state = TableState.Active;
        table.currentRound = 0;

        Round storage round = rounds[_tableId][0];
        round.state = true;
        round.players = table.players;
        round.highestChip = table.bigBlind;
        round.turn = 0;
        round.actsSinceReset = 0;
        delete round.chips;
        delete round.folded;
        for (uint k = 0; k < n; k++) {
            round.chips.push(0);
            round.folded.push(false);
        }

        for (uint i = 0; i < n; i++) {
            if (i == n - 1) {
                uint sb = table.bigBlind / 2;
                round.chips[i] = sb;
                chips[round.players[i]][_tableId] -= sb;
            } else if (i == n - 2) {
                round.chips[i] = table.bigBlind;
                chips[round.players[i]][_tableId] -= table.bigBlind;
            }
            playerHashes[table.players[i]][_tableId][table.totalHands] = _playerCards[i];
        }

        table.pot += table.bigBlind + (table.bigBlind / 2);
        emit CardsDealt(_tableId, table.totalHands, _playerCards);
    }

    function dealCommunityCards(uint _tableId, uint _roundId, uint8[] memory _cards) external onlyOwner {
        require(_roundId == tables[_tableId].currentRound, "wrong round"); // L2
        for (uint i = 0; i < _cards.length; i++) {
            communityCards[_tableId].push(_cards[i]);
        }
        emit CommunityCardsDealt(_tableId, _roundId, _cards);
    }

    function showdown(
        uint _tableId,
        uint[] memory _keys,
        PlayerCards[] memory _cards,
        address _winner,
        uint _swapMinOut
    ) external onlyOwner nonReentrant {
        Table storage table = tables[_tableId];
        require(table.state == TableState.Showdown, "not in showdown");

        Round storage round = rounds[_tableId][LAST_ROUND];
        uint n = round.players.length;
        require(_keys.length == n && _cards.length == n, "Incorrect arr length");
        require(_winner != address(0), "Winner is zero");

        // Verify hashes for non-folded players only
        for (uint i = 0; i < n; i++) {
            if (round.folded[i]) continue;
            bytes32 h1 = keccak256(abi.encodePacked(_keys[i], _cards[i].card1));
            bytes32 h2 = keccak256(abi.encodePacked(_keys[i], _cards[i].card2));
            PlayerCardHashes memory stored = playerHashes[round.players[i]][_tableId][table.totalHands];
            require(stored.card1Hash == h1 && stored.card2Hash == h2, "incorrect cards");
        }

        // Winner must be in showdown AND not folded
        bool winnerValid = false;
        for (uint i = 0; i < n; i++) {
            if (round.players[i] == _winner && !round.folded[i]) {
                winnerValid = true;
                break;
            }
        }
        require(winnerValid, "Winner not in round");

        // H2 — sanity check minOut > 0 for non-MOLLY rake swap if there's something to swap
        if (address(table.token) != MOLLY_TOKEN) {
            uint rake = (table.pot * RAKE_BPS) / BPS;
            if (rake > 0 && swapRouter != address(0)) {
                require(_swapMinOut > 0, "minOut=0 (sandwich risk)");
            }
        }

        emit CardsRevealed(_tableId, table.totalHands, round.players, _cards, communityCards[_tableId], round.folded);

        _distributePot(table, _tableId, _winner, _swapMinOut, true);
    }

    /* ============================================================
       ROUND PROGRESSION — C1+C2 fix
       ============================================================ */
    function _finishRound(uint _tableId, Table storage _table) internal {
        Round storage _round = rounds[_tableId][_table.currentRound];
        uint n = _round.players.length;

        uint activeCount = 0;
        address lastActive;
        for (uint i = 0; i < n; i++) {
            if (!_round.folded[i]) {
                activeCount++;
                lastActive = _round.players[i];
            }
        }

        if (activeCount == 1) {
            // win by fold — Audit M1 (pass 2): always raw-transfer rake on this path
            //   (no opportunity for the dealer to compute swap slippage off-chain
            //   since fold-wins happen synchronously inside playHand).
            _distributePot(_table, _tableId, lastActive, 0, false);
            return;
        }

        bool allMatched = true;
        for (uint i = 0; i < n; i++) {
            if (!_round.folded[i] && _round.chips[i] != _round.highestChip) {
                allMatched = false;
                break;
            }
        }
        // C2 — round closes when every active player has had a chance to act since
        //       the last raise AND all bets match. Works for re-raises, mid-round
        //       folds, and the river-checked-through case the auditor caught.
        bool roundComplete = allMatched && (_round.actsSinceReset >= activeCount);

        if (roundComplete) {
            if (_table.currentRound == LAST_ROUND) {
                _table.state = TableState.Showdown;
                emit ShowdownStarted(_tableId, _table.totalHands);
            } else {
                emit RoundOver(_tableId, _table.currentRound);
                _table.currentRound += 1;
                _initNextRound(_tableId, _table.currentRound, _round.players, _round.folded);
            }
        } else {
            _round.turn = _nextActiveTurn(_round.turn, _round.folded);
        }
    }

    function _initNextRound(
        uint _tableId,
        uint _roundId,
        address[] memory _players,
        bool[] memory _folded
    ) internal {
        uint n = _players.length;
        uint[] memory _chips = new uint[](n);
        uint firstTurn = 0;
        for (uint i = 0; i < n; i++) {
            if (!_folded[i]) { firstTurn = i; break; }
        }
        rounds[_tableId][_roundId] = Round({
            state: true,
            turn: firstTurn,
            players: _players,
            highestChip: 0,
            chips: _chips,
            folded: _folded,
            actsSinceReset: 0
        });
    }

    function _nextActiveTurn(uint _curr, bool[] storage _folded) internal view returns (uint) {
        uint n = _folded.length;
        for (uint i = 1; i <= n; i++) {
            uint idx = (_curr + i) % n;
            if (!_folded[idx]) return idx;
        }
        revert("no active players");
    }

    /* ============================================================
       POT DISTRIBUTION
       ============================================================ */
    function _distributePot(
        Table storage _table,
        uint _tableId,
        address _winner,
        uint _swapMinOut,
        bool _trySwap
    ) internal {
        uint pot = _table.pot;
        uint handNum = _table.totalHands;

        if (pot == 0) {
            _reInitiateTable(_table, _tableId);
            return;
        }

        address tableToken = address(_table.token);

        if (tableToken == MOLLY_TOKEN) {
            uint burnAmt = (pot * BURN_BPS) / BPS;
            uint devAmt  = (pot * DEV_BPS)  / BPS;
            uint winnerAmt = pot - burnAmt - devAmt;

            chips[_winner][_tableId] += winnerAmt;
            if (burnAmt > 0) _table.token.safeTransfer(BURN_ADDR, burnAmt);
            if (devAmt  > 0) _table.token.safeTransfer(DEV_ADDR,  devAmt);

            emit PotDistributed(_tableId, handNum, _winner, tableToken, winnerAmt, burnAmt, devAmt, 0);
        } else {
            uint rakeAmt = (pot * RAKE_BPS) / BPS;
            uint winnerAmt = pot - rakeAmt;

            chips[_winner][_tableId] += winnerAmt;

            uint wmonOut = 0;
            if (rakeAmt > 0) {
                // Audit M1 (pass 2): only swap when caller (showdown) explicitly opts in.
                // Fold-win path enters with _trySwap=false because there's no opportunity
                // to compute slippage off-chain — defaults to raw token transfer.
                if (_trySwap && swapRouter != address(0)) {
                    try this._performSwap(tableToken, rakeAmt, _swapMinOut) returns (uint out) {
                        wmonOut = out;
                        IERC20(WMON).safeTransfer(DEV_ADDR, wmonOut);
                    } catch Error(string memory reason) {
                        emit RakeSwapFailed(_tableId, tableToken, rakeAmt, reason);
                        _table.token.safeTransfer(DEV_ADDR, rakeAmt);
                    } catch {
                        emit RakeSwapFailed(_tableId, tableToken, rakeAmt, "unknown");
                        _table.token.safeTransfer(DEV_ADDR, rakeAmt);
                    }
                } else {
                    // Either router unset OR caller chose raw transfer (fold-win)
                    _table.token.safeTransfer(DEV_ADDR, rakeAmt);
                }
            }
            emit PotDistributed(_tableId, handNum, _winner, tableToken, winnerAmt, 0, rakeAmt, wmonOut);
        }
        _reInitiateTable(_table, _tableId);
    }

    function _performSwap(address _token, uint _amountIn, uint _minOut) external returns (uint) {
        require(msg.sender == address(this), "self only");
        return _swapToWMON(_token, _amountIn, _minOut);
    }

    function _swapToWMON(address _token, uint _amountIn, uint _minOut) internal returns (uint amountOut) {
        IERC20(_token).forceApprove(swapRouter, _amountIn);
        uint24 fee = poolFee[_token];
        if (fee == 0) fee = DEFAULT_POOL_FEE;
        ISwapRouterV3.ExactInputSingleParams memory params = ISwapRouterV3.ExactInputSingleParams({
            tokenIn:           _token,
            tokenOut:          WMON,
            fee:               fee,
            recipient:         address(this),
            deadline:          block.timestamp, // M5
            amountIn:          _amountIn,
            amountOutMinimum:  _minOut,
            sqrtPriceLimitX96: 0
        });
        amountOut = ISwapRouterV3(swapRouter).exactInputSingle(params);
        IERC20(_token).forceApprove(swapRouter, 0);
    }

    function _reInitiateTable(Table storage _table, uint _tableId) internal {
        _table.state = TableState.Inactive;
        _table.totalHands += 1;
        _table.currentRound = 0;
        _table.pot = 0;
        delete communityCards[_tableId];
        // M6 — wipe stale round data
        for (uint i = 0; i <= LAST_ROUND; i++) {
            delete rounds[_tableId][i];
        }
    }

    /* ============================================================
       EMERGENCY
       ============================================================ */
    /// Audit P3 M1: emergencyRefund takes ONLY the tableId now. The old
    /// (tableId, address[]) signature let a refunded subset walk away with the
    /// full table.pot — including chips that non-refunded seated players had
    /// contributed via blinds/calls. This atomic version iterates table.players
    /// itself so partial refunds are impossible by construction.
    function emergencyRefund(uint _tableId) external onlyOwner nonReentrant {
        Table storage table = tables[_tableId];
        require(table.state != TableState.Showdown, "in showdown");

        uint n = table.players.length;

        // Edge case: no seated players. Sweep any stale pot to dev and reset.
        if (n == 0) {
            if (table.pot > 0) {
                table.token.safeTransfer(DEV_ADDR, table.pot);
                emit EmergencyRefund(_tableId, DEV_ADDR, table.pot);
                table.pot = 0;
            }
            // P4 L2 — match the n>0 cleanup for symmetry (no-op when already empty)
            table.state = TableState.Inactive;
            table.currentRound = 0;
            delete communityCards[_tableId];
            for (uint i = 0; i <= LAST_ROUND; i++) {
                delete rounds[_tableId][i];
            }
            return;
        }

        // P4 L5 — Snapshot to memory BEFORE we delete table.players below.
        // The snapshot is used by the pot-split loop after the delete; do not
        // collapse this into iterating table.players directly.
        address[] memory all = new address[](n);
        for (uint i = 0; i < n; i++) all[i] = table.players[i];

        // Refund each player's chip balance + clear seated flag
        for (uint i = 0; i < n; i++) {
            address p = all[i];
            uint amt = chips[p][_tableId];
            if (amt > 0) {
                chips[p][_tableId] = 0;
                table.token.safeTransfer(p, amt);
                emit EmergencyRefund(_tableId, p, amt);
            }
            seated[_tableId][p] = false;
        }

        // Wipe player roster
        delete table.players;

        // Audit P2 M2: split residual table.pot equally so no tokens are leaked.
        // Now safe to do because we know every contributor is in `all`.
        if (table.pot > 0) {
            uint per = table.pot / n;
            if (per > 0) {
                for (uint i = 0; i < n; i++) {
                    table.token.safeTransfer(all[i], per);
                    emit EmergencyRefund(_tableId, all[i], per);
                }
            }
            uint dust = table.pot - (per * n);
            if (dust > 0) {
                table.token.safeTransfer(all[0], dust);
                emit EmergencyRefund(_tableId, all[0], dust);
            }
            table.pot = 0;
        }

        // Reset table to a clean slate so the dealer can recreate / players can re-buyIn
        table.state = TableState.Inactive;
        table.currentRound = 0;
        delete communityCards[_tableId];
        for (uint i = 0; i <= LAST_ROUND; i++) {
            delete rounds[_tableId][i];
        }
    }

    /* ============================================================
       UTILS + VIEWS
       ============================================================ */
    function _removeFromPlayers(address[] storage arr, address target) internal {
        for (uint i = 0; i < arr.length; i++) {
            if (arr[i] == target) {
                if (i != arr.length - 1) arr[i] = arr[arr.length - 1];
                arr.pop();
                return;
            }
        }
    }

    function getTablePlayers(uint _tableId) external view returns (address[] memory) {
        return tables[_tableId].players;
    }

    function getRound(uint _tableId, uint _roundId)
        external view
        returns (
            bool state,
            uint turn,
            address[] memory players,
            uint highestChip,
            uint[] memory roundChips,
            bool[] memory folded,
            uint actsSinceReset
        )
    {
        Round storage r = rounds[_tableId][_roundId];
        return (r.state, r.turn, r.players, r.highestChip, r.chips, r.folded, r.actsSinceReset);
    }

    function getCommunityCards(uint _tableId) external view returns (uint8[] memory) {
        return communityCards[_tableId];
    }

    function canPlay(address _user) external view returns (bool) {
        return IERC20(MOLLY_TOKEN).balanceOf(_user) >= mollyHoldRequired;
    }
}
