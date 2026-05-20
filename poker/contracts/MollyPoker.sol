// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*
   __  ___   __  __         ___       _
  /  |/  /__/ / / /_ __    / _ \___  / /_____ ____
 / /|_/ / _ / // / // /   / ___/ _ \/  '_/ -_) __/
/_/  /_/\_,_/\_,_/\_, /   /_/   \___/_/\_\\__/_/
                 /___/

  Semi-decentralized Texas Hold'em on Monad.

  MOLLY is the universal access pass: every player must hold at least
  100K MOLLY in their wallet to buy in to ANY table (MOLLY or otherwise).
  This makes MOLLY the entry-pass token for a multi-project poker network.

  Each table runs in ONE token. Whitelisted projects can create tables
  in their own token. The 30% rake routing differs:

    - MOLLY tables:   20% burned (→ 0xdead), 10% to dev wallet (MOLLY)
    - Other tables:   30% auto-swapped to WMON via Crust V3 router,
                      WMON sent to dev wallet (admin burns manually later)

  Winners' 70% pot goes to their chips at the table (in the table's
  token). Winners pay their own gas to withdraw — `withdrawChips` is
  the claim button. Optionally, winners can call `withdrawAsWMON` to
  swap their chips to WMON in the same tx.

  Forked from dxganta/poker-solidity (MIT) with simplified architecture:
  - No on-chain hand evaluator (dealer node computes off-chain)
  - 70/30 split with token-aware rake routing
  - 100K MOLLY hold gate
  - Whitelisted creators
  - Configurable swap router for non-MOLLY rake auto-conversion
*/

import {IERC20}           from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}        from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable}          from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard}  from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Minimal interface for Uniswap V3-style swap router (Crust Finance on Monad)
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
        address creator; // tracks who created the table (for accountability)
    }
    struct Round {
        bool state;
        uint turn;
        address[] players;
        uint highestChip;
        uint[] chips;
    }
    struct PlayerCardHashes { bytes32 card1Hash; bytes32 card2Hash; }
    struct PlayerCards      { uint8 card1;       uint8 card2; }

    /* ---------- events ---------- */

    event NewTableCreated(uint indexed tableId, address indexed creator, address indexed token, uint buyIn, uint bigBlind);
    event NewBuyIn(uint indexed tableId, address indexed player, uint amount);
    event Withdrawn(uint indexed tableId, address indexed player, address indexed token, uint amount);
    event WithdrawnAsWMON(uint indexed tableId, address indexed player, address tokenIn, uint amountIn, uint wmonOut);
    event CardsDealt(uint indexed tableId, uint handNum, PlayerCardHashes[] cardHashes);
    event ActionTaken(uint indexed tableId, uint roundId, address indexed player, PlayerAction action, uint amount);
    event RoundOver(uint indexed tableId, uint roundId);
    event CommunityCardsDealt(uint indexed tableId, uint roundId, uint8[] cards);
    event ShowdownStarted(uint indexed tableId, uint handNum);
    event CardsRevealed(uint indexed tableId, uint indexed handNum, address[] players, PlayerCards[] cards, uint8[] community);
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

    /// MOLLY table split: 70% winner / 20% burn / 10% dev (in BPS)
    uint16 public constant WINNER_BPS = 7000;
    uint16 public constant BURN_BPS   = 2000;
    uint16 public constant DEV_BPS    = 1000;
    /// Non-MOLLY table split: 70% winner / 30% dev (in WMON)
    uint16 public constant RAKE_BPS   = 3000;
    uint16 public constant BPS        = 10_000;

    uint24  public constant DEFAULT_POOL_FEE = 10_000; // 1% tier (most memecoin pools)
    uint256 public constant SWAP_DEADLINE   = 300;     // 5 min

    /* ---------- immutable ---------- */

    address public immutable BURN_ADDR;     // 0x...dEaD
    address public immutable DEV_ADDR;      // 0xa424c64aa051cf75749b6377bfc86f20f212cb24
    address public immutable MOLLY_TOKEN;   // entry-pass token
    address public immutable WMON;          // wrapped MON

    /* ---------- mutable config ---------- */

    address public swapRouter;                              // Crust V3 router (settable post-deploy)
    uint    public mollyHoldRequired = 100_000 ether;       // 100K MOLLY
    mapping(address => bool)   public whitelistedCreator;   // projects approved to spin up tables
    mapping(address => uint24) public poolFee;              // per-token V3 pool fee override

    /* ---------- table state ---------- */

    uint public totalTables;
    mapping(uint => Table) public tables;
    mapping(address => mapping(uint => uint)) public chips;
    mapping(address => mapping(uint => mapping(uint => PlayerCardHashes))) public playerHashes;
    mapping(uint => mapping(uint => Round)) public rounds;
    mapping(uint => uint8[]) public communityCards;

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
        address _swapRouter // can be 0 initially, set later
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
       ADMIN / CONFIG
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
        address old = swapRouter;
        swapRouter = _router;
        emit SwapRouterUpdated(old, _router);
    }

    function setPoolFee(address _token, uint24 _fee) external onlyOwner {
        // Valid Uniswap V3 fee tiers: 100, 500, 3000, 10000
        require(_fee == 100 || _fee == 500 || _fee == 3000 || _fee == 10000, "bad fee");
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
        // Universal MOLLY hold gate
        require(
            IERC20(MOLLY_TOKEN).balanceOf(msg.sender) >= mollyHoldRequired,
            "need 100k MOLLY"
        );

        Table storage table = tables[_tableId];
        require(_amount >= table.buyInAmount, "Not enough buyInAmount");
        require(table.players.length < table.maxPlayers, "Table full");

        table.token.safeTransferFrom(msg.sender, address(this), _amount);
        chips[msg.sender][_tableId] += _amount;
        table.players.push(msg.sender);

        emit NewBuyIn(_tableId, msg.sender, _amount);
    }

    /// Standard withdraw — returns the table's token (the "claim" button)
    function withdrawChips(uint _amount, uint _tableId) external nonReentrant {
        require(chips[msg.sender][_tableId] >= _amount, "Not enough balance");
        chips[msg.sender][_tableId] -= _amount;
        address tok = address(tables[_tableId].token);
        IERC20(tok).safeTransfer(msg.sender, _amount);
        emit Withdrawn(_tableId, msg.sender, tok, _amount);
    }

    /// Auto-swap variant: withdraw chips as WMON. Pays own gas. Only for non-MOLLY tables.
    function withdrawAsWMON(uint _amount, uint _tableId, uint _minWmonOut) external nonReentrant {
        Table storage table = tables[_tableId];
        address tok = address(table.token);
        require(tok != MOLLY_TOKEN, "use withdrawChips for MOLLY");
        require(chips[msg.sender][_tableId] >= _amount, "Not enough balance");
        require(swapRouter != address(0), "no router");

        chips[msg.sender][_tableId] -= _amount;

        uint wmonOut = _swapToWMON(tok, _amount, _minWmonOut);
        IERC20(WMON).safeTransfer(msg.sender, wmonOut);

        emit WithdrawnAsWMON(_tableId, msg.sender, tok, _amount, wmonOut);
    }

    function playHand(uint _tableId, PlayerAction _action, uint _raiseAmount) external {
        Table storage table = tables[_tableId];
        require(table.state == TableState.Active, "No Active Round");

        Round storage round = rounds[_tableId][table.currentRound];
        require(round.players[round.turn] == msg.sender, "Not your turn");

        uint amountForEvent = 0;

        if (_action == PlayerAction.Call) {
            uint callAmount = round.highestChip - round.chips[round.turn];
            require(chips[msg.sender][_tableId] >= callAmount, "no chips");
            chips[msg.sender][_tableId] -= callAmount;
            round.chips[round.turn] += callAmount;
            table.pot += callAmount;
            amountForEvent = callAmount;

        } else if (_action == PlayerAction.Check) {
            for (uint i = 0; i < round.players.length; i++) {
                require(round.chips[i] == 0, "Check not possible");
            }

        } else if (_action == PlayerAction.Raise) {
            uint totalAmount = _raiseAmount + round.chips[round.turn];
            require(totalAmount > round.highestChip, "Raise amount not enough");
            require(chips[msg.sender][_tableId] >= _raiseAmount, "no chips");
            chips[msg.sender][_tableId] -= _raiseAmount;
            round.chips[round.turn] += _raiseAmount;
            table.pot += _raiseAmount;
            round.highestChip = totalAmount;
            amountForEvent = _raiseAmount;

        } else if (_action == PlayerAction.Fold) {
            _remove(round.turn, round.players);
            _remove(round.turn, round.chips);
        }

        emit ActionTaken(_tableId, table.currentRound, msg.sender, _action, amountForEvent);

        _finishRound(_tableId, table);
    }

    /* ============================================================
       DEALER NODE (owner)
       ============================================================ */

    function dealCards(PlayerCardHashes[] memory _playerCards, uint _tableId)
        external
        onlyOwner
    {
        Table storage table = tables[_tableId];
        uint n = table.players.length;
        require(table.state == TableState.Inactive, "Game already going on");
        require(n > 1 && _playerCards.length == n, "ERROR: PlayerCardHashes Length");

        table.state = TableState.Active;
        table.currentRound = 0;

        Round storage round = rounds[_tableId][0];
        round.state = true;
        round.players = table.players;
        round.highestChip = table.bigBlind;
        delete round.chips;
        for (uint k = 0; k < n; k++) {
            round.chips.push(0);
        }
        round.turn = 0;

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

    function dealCommunityCards(uint _tableId, uint _roundId, uint8[] memory _cards)
        external
        onlyOwner
    {
        for (uint i = 0; i < _cards.length; i++) {
            communityCards[_tableId].push(_cards[i]);
        }
        emit CommunityCardsDealt(_tableId, _roundId, _cards);
    }

    /// @notice Dealer reveals hole cards + declares winner. For non-MOLLY tables, the
    ///         30% rake gets auto-swapped to WMON via the configured router. The dealer
    ///         passes _swapMinOut as slippage protection (calculated off-chain).
    /// @param _swapMinOut min WMON expected from the rake swap. Pass 0 for MOLLY tables.
    function showdown(
        uint _tableId,
        uint[] memory _keys,
        PlayerCards[] memory _cards,
        address _winner,
        uint _swapMinOut
    ) external onlyOwner nonReentrant {
        Table storage table = tables[_tableId];
        require(table.state == TableState.Showdown, "not in showdown");

        address[] memory players = rounds[_tableId][3].players;
        uint n = players.length;
        require(_keys.length == n && _cards.length == n, "Incorrect arr length");
        require(_winner != address(0), "Winner is zero");

        _verifyCards(_tableId, table.totalHands, players, _keys, _cards);

        bool winnerValid = false;
        for (uint i = 0; i < n; i++) {
            if (players[i] == _winner) { winnerValid = true; break; }
        }
        require(winnerValid, "Winner not in round");

        emit CardsRevealed(_tableId, table.totalHands, players, _cards, communityCards[_tableId]);

        _distributePot(table, _tableId, _winner, _swapMinOut);
    }

    function _verifyCards(
        uint _tableId,
        uint _handNum,
        address[] memory _players,
        uint[] memory _keys,
        PlayerCards[] memory _cards
    ) internal view {
        for (uint i = 0; i < _players.length; i++) {
            bytes32 h1 = keccak256(abi.encodePacked(_keys[i], _cards[i].card1));
            bytes32 h2 = keccak256(abi.encodePacked(_keys[i], _cards[i].card2));
            PlayerCardHashes memory stored = playerHashes[_players[i]][_tableId][_handNum];
            require(stored.card1Hash == h1 && stored.card2Hash == h2, "incorrect cards");
        }
    }

    /* ============================================================
       POT DISTRIBUTION
       ============================================================ */

    function _distributePot(
        Table storage _table,
        uint _tableId,
        address _winner,
        uint _swapMinOut
    ) internal {
        uint pot = _table.pot;
        uint handNum = _table.totalHands;

        if (pot == 0) {
            _reInitiateTable(_table, _tableId);
            return;
        }

        address tableToken = address(_table.token);

        if (tableToken == MOLLY_TOKEN) {
            // MOLLY table: 70% winner / 20% burn / 10% dev — all in MOLLY
            uint burnAmt = (pot * BURN_BPS) / BPS;
            uint devAmt  = (pot * DEV_BPS)  / BPS;
            uint winnerAmt = pot - burnAmt - devAmt;

            chips[_winner][_tableId] += winnerAmt;
            if (burnAmt > 0) _table.token.safeTransfer(BURN_ADDR, burnAmt);
            if (devAmt  > 0) _table.token.safeTransfer(DEV_ADDR,  devAmt);

            emit PotDistributed(_tableId, handNum, _winner, tableToken, winnerAmt, burnAmt, devAmt, 0);
        } else {
            // Non-MOLLY: 70% winner stays in table token / 30% auto-swapped to WMON for dev
            uint rakeAmt = (pot * RAKE_BPS) / BPS;
            uint winnerAmt = pot - rakeAmt;

            chips[_winner][_tableId] += winnerAmt;

            uint wmonOut = 0;
            if (rakeAmt > 0) {
                if (swapRouter != address(0)) {
                    // try the swap; on failure, fall back to sending raw tokens
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
                    // no router configured — fall back to raw token
                    _table.token.safeTransfer(DEV_ADDR, rakeAmt);
                }
            }

            emit PotDistributed(_tableId, handNum, _winner, tableToken, winnerAmt, 0, rakeAmt, wmonOut);
        }

        _reInitiateTable(_table, _tableId);
    }

    /// External wrapper around _swapToWMON so we can try/catch the swap in _distributePot.
    /// Only callable by the contract itself.
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
            deadline:          block.timestamp + SWAP_DEADLINE,
            amountIn:          _amountIn,
            amountOutMinimum:  _minOut,
            sqrtPriceLimitX96: 0
        });
        amountOut = ISwapRouterV3(swapRouter).exactInputSingle(params);

        // Reset approval to 0 for safety
        IERC20(_token).forceApprove(swapRouter, 0);
    }

    /* ============================================================
       ROUND PROGRESSION
       ============================================================ */

    function _finishRound(uint _tableId, Table storage _table) internal {
        Round storage _round = rounds[_tableId][_table.currentRound];
        uint n = _round.players.length;

        if (n == 1) {
            // everyone else folded — last player wins by default
            // (no swap needed for fold wins on non-MOLLY since pot is small; pass 0)
            _distributePot(_table, _tableId, _round.players[0], 0);
            return;
        }

        if (_allElementsEqual(_round.chips)) {
            if (_table.currentRound == 3) {
                _table.state = TableState.Showdown;
                emit ShowdownStarted(_tableId, _table.totalHands);
            } else if (_round.turn == n - 1) {
                emit RoundOver(_tableId, _table.currentRound);
                _table.currentRound += 1;

                uint[] memory _chips = new uint[](n);
                rounds[_tableId][_table.currentRound] = Round({
                    state: true,
                    turn: 0,
                    players: _round.players,
                    highestChip: 0,
                    chips: _chips
                });
            } else {
                _round.turn = _updateTurn(_round.turn, n);
            }
        } else {
            _round.turn = _updateTurn(_round.turn, n);
        }
    }

    function _updateTurn(uint _t, uint _n) internal pure returns (uint) {
        if (_t == _n - 1) return 0;
        return _t + 1;
    }

    function _reInitiateTable(Table storage _table, uint _tableId) internal {
        _table.state = TableState.Inactive;
        _table.totalHands += 1;
        _table.currentRound = 0;
        _table.pot = 0;
        delete communityCards[_tableId];

        Round storage round = rounds[_tableId][0];
        round.state = true;
        round.players = _table.players;
        round.highestChip = _table.bigBlind;
    }

    /* ============================================================
       EMERGENCY
       ============================================================ */

    function emergencyRefund(uint _tableId, address[] calldata _players)
        external
        onlyOwner
        nonReentrant
    {
        Table storage table = tables[_tableId];
        require(table.state != TableState.Showdown, "in showdown");
        for (uint i = 0; i < _players.length; i++) {
            address p = _players[i];
            uint amt = chips[p][_tableId];
            if (amt > 0) {
                chips[p][_tableId] = 0;
                table.token.safeTransfer(p, amt);
                emit EmergencyRefund(_tableId, p, amt);
            }
        }
    }

    /* ============================================================
       UTILS + VIEWS
       ============================================================ */

    function _allElementsEqual(uint[] memory arr) internal pure returns (bool) {
        if (arr.length == 0) return true;
        uint x = arr[0];
        for (uint i = 1; i < arr.length; i++) {
            if (arr[i] != x) return false;
        }
        return true;
    }

    function _remove(uint index, address[] storage arr) internal {
        arr[index] = arr[arr.length - 1];
        arr.pop();
    }

    function _remove(uint index, uint[] storage arr) internal {
        arr[index] = arr[arr.length - 1];
        arr.pop();
    }

    function getTablePlayers(uint _tableId) external view returns (address[] memory) {
        return tables[_tableId].players;
    }

    function getRound(uint _tableId, uint _roundId)
        external
        view
        returns (
            bool state,
            uint turn,
            address[] memory players,
            uint highestChip,
            uint[] memory roundChips
        )
    {
        Round storage r = rounds[_tableId][_roundId];
        return (r.state, r.turn, r.players, r.highestChip, r.chips);
    }

    function getCommunityCards(uint _tableId) external view returns (uint8[] memory) {
        return communityCards[_tableId];
    }

    /// Eligibility check for the frontend — "can this address sit at a table?"
    function canPlay(address _user) external view returns (bool) {
        return IERC20(MOLLY_TOKEN).balanceOf(_user) >= mollyHoldRequired;
    }
}
