// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*
   __  ___   __  __         ___       _
  /  |/  /__/ / / /_ __    / _ \___  / /_____ ____
 / /|_/ / _ / // / // /   / ___/ _ \/  '_/ -_) __/
/_/  /_/\_,_/\_,_/\_, /   /_/   \___/_/\_\\__/_/
                 /___/

  Semi-decentralized Texas Hold'em on Monad. Pot split 70/20/10
  (winner / burn / dev). Trusted-dealer architecture: the dealer
  node (a server we run) handles randomness, commit-reveal of
  hole cards, and computes the winner off-chain. The chain
  enforces the money: who's in the table, what they bet, where
  the pot goes.

  WHY OFF-CHAIN EVALUATION?
    The reference fork (dxganta/poker-solidity) shipped a 21-contract
    on-chain 7-card hand evaluator using ~600KB of lookup tables.
    Most of those contracts exceed EIP-170's 24KB cap and can't be
    deployed. Even if we split them up, every showdown would cost
    serious gas to run a deterministic computation that anyone with
    a JS hand evaluator can verify off-chain in microseconds.

  TRUST MODEL:
    The dealer is already trusted to (a) deal random cards fairly
    and (b) reveal them honestly at showdown. The contract makes
    cheating detectable post-hoc: it logs every card the dealer
    reveals, so the community can independently verify the winner
    using any open-source poker evaluator. If the dealer ever picks
    the wrong winner, it shows up immediately in the event log.
    Same trust radius, fraction of the complexity.

  FORKED FROM: dxganta/poker-solidity (MIT)

  CHANGES vs upstream:
    - 70/20/10 pot split (was 100% winner)
    - Dealer-declared winner with sanity checks (was on-chain Evaluator7)
    - Fix dealCards bug (chips array now properly sized before access)
    - SafeERC20 transfers + ReentrancyGuard
    - emergencyRefund (owner can refund chip balances if dealer crashes)
    - Cards revealed as events so community can independently verify
    - Solidity 0.8.24, all math checked, optimizer 200 runs
*/

import {IERC20}           from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}        from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable}          from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard}  from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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

    event NewTableCreated(uint indexed tableId, address indexed token, uint buyIn, uint bigBlind);
    event NewBuyIn(uint indexed tableId, address indexed player, uint amount);
    event Withdrawn(uint indexed tableId, address indexed player, uint amount);
    event CardsDealt(uint indexed tableId, uint handNum, PlayerCardHashes[] cardHashes);
    event ActionTaken(
        uint indexed tableId,
        uint roundId,
        address indexed player,
        PlayerAction action,
        uint amount
    );
    event RoundOver(uint indexed tableId, uint roundId);
    event CommunityCardsDealt(uint indexed tableId, uint roundId, uint8[] cards);
    event ShowdownStarted(uint indexed tableId, uint handNum);

    /// Logged so the community can independently verify the winner
    /// using any open-source 7-card evaluator. If the dealer ever
    /// picks the wrong winner, it's immediately obvious from this log.
    event CardsRevealed(
        uint indexed tableId,
        uint indexed handNum,
        address[] players,
        PlayerCards[] cards,
        uint8[] community
    );

    event PotDistributed(
        uint indexed tableId,
        uint indexed handNum,
        address indexed winner,
        uint winnerAmount,
        uint burnAmount,
        uint devAmount
    );
    event EmergencyRefund(uint indexed tableId, address indexed player, uint amount);

    /* ---------- constants ---------- */

    /// 70 / 20 / 10 split in basis points. Sums to 10000 = 100%.
    uint16 public constant WINNER_BPS = 7000;
    uint16 public constant BURN_BPS   = 2000;
    uint16 public constant DEV_BPS    = 1000;
    uint16 public constant BPS        = 10_000;

    /* ---------- config (immutable) ---------- */

    address public immutable BURN_ADDR; // 0x000...dEaD typically
    address public immutable DEV_ADDR;  // Molly team wallet (penalty + rake)

    /* ---------- state ---------- */

    uint public totalTables;
    mapping(uint => Table) public tables;
    mapping(address => mapping(uint => uint)) public chips; // player => tableId => chips
    mapping(address => mapping(uint => mapping(uint => PlayerCardHashes))) public playerHashes;
    mapping(uint => mapping(uint => Round)) public rounds;  // tableId => roundId => Round
    mapping(uint => uint8[]) public communityCards;         // tableId => community cards

    constructor(address _burnAddr, address _devAddr) Ownable(msg.sender) {
        require(_burnAddr != address(0), "burn=0");
        require(_devAddr  != address(0), "dev=0");
        require(WINNER_BPS + BURN_BPS + DEV_BPS == BPS, "bps != 10000");
        BURN_ADDR = _burnAddr;
        DEV_ADDR  = _devAddr;
    }

    /* ============================================================
       PLAYER ACTIONS
       ============================================================ */

    function createTable(
        uint _buyInAmount,
        uint _maxPlayers,
        uint _bigBlind,
        address _token
    ) external {
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
            token: IERC20(_token)
        });

        emit NewTableCreated(totalTables, _token, _buyInAmount, _bigBlind);
        totalTables += 1;
    }

    function buyIn(uint _tableId, uint _amount) external nonReentrant {
        Table storage table = tables[_tableId];

        require(_amount >= table.buyInAmount, "Not enough buyInAmount");
        require(table.players.length < table.maxPlayers, "Table full");

        table.token.safeTransferFrom(msg.sender, address(this), _amount);
        chips[msg.sender][_tableId] += _amount;
        table.players.push(msg.sender);

        emit NewBuyIn(_tableId, msg.sender, _amount);
    }

    function withdrawChips(uint _amount, uint _tableId) external nonReentrant {
        require(chips[msg.sender][_tableId] >= _amount, "Not enough balance");
        chips[msg.sender][_tableId] -= _amount;
        tables[_tableId].token.safeTransfer(msg.sender, _amount);
        emit Withdrawn(_tableId, msg.sender, _amount);
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
       DEALER NODE (owner) — deals cards, runs showdown
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

        // properly size the chips array (upstream bug fix)
        Round storage round = rounds[_tableId][0];
        round.state = true;
        round.players = table.players;
        round.highestChip = table.bigBlind;
        delete round.chips;
        for (uint k = 0; k < n; k++) {
            round.chips.push(0);
        }
        round.turn = 0;

        // post blinds (heads-up: last player = SB, second-last = BB)
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

    /// @notice Dealer reveals hole cards + declares the winner.
    ///         Contract verifies the commit-reveal, checks the winner
    ///         is actually in the showdown round, and distributes
    ///         the pot 70/20/10. The cards are logged as an event so
    ///         anyone can independently verify the winner using their
    ///         own hand evaluator.
    function showdown(
        uint _tableId,
        uint[] memory _keys,
        PlayerCards[] memory _cards,
        address _winner
    ) external onlyOwner nonReentrant {
        Table storage table = tables[_tableId];
        require(table.state == TableState.Showdown, "not in showdown");

        address[] memory players = rounds[_tableId][3].players;
        uint n = players.length;
        require(_keys.length == n && _cards.length == n, "Incorrect arr length");
        require(_winner != address(0), "Winner is zero");

        // 1. verify commit-reveal for every player
        _verifyCards(_tableId, table.totalHands, players, _keys, _cards);

        // 2. sanity check: winner must be in the showdown round's player set
        bool winnerValid = false;
        for (uint i = 0; i < n; i++) {
            if (players[i] == _winner) { winnerValid = true; break; }
        }
        require(winnerValid, "Winner not in round");

        // 3. emit the full reveal — the community's audit log
        emit CardsRevealed(_tableId, table.totalHands, players, _cards, communityCards[_tableId]);

        // 4. distribute pot 70 / 20 / 10
        _distributePot(table, _tableId, _winner);
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
       POT DISTRIBUTION — the Molly economic core
       ============================================================ */

    function _distributePot(Table storage _table, uint _tableId, address _winner) internal {
        uint pot = _table.pot;
        uint handNum = _table.totalHands;

        if (pot == 0) {
            _reInitiateTable(_table, _tableId);
            return;
        }

        // 70 / 20 / 10 split
        uint burnAmt = (pot * BURN_BPS) / BPS;
        uint devAmt  = (pot * DEV_BPS)  / BPS;
        uint winnerAmt = pot - burnAmt - devAmt; // remainder to winner (covers rounding)

        // winner's portion stays as chips in the contract (no transfer — table continues)
        chips[_winner][_tableId] += winnerAmt;

        // burn + dev are real ERC20 transfers out of the contract
        if (burnAmt > 0) _table.token.safeTransfer(BURN_ADDR, burnAmt);
        if (devAmt  > 0) _table.token.safeTransfer(DEV_ADDR,  devAmt);

        emit PotDistributed(_tableId, handNum, _winner, winnerAmt, burnAmt, devAmt);

        _reInitiateTable(_table, _tableId);
    }

    /* ============================================================
       ROUND PROGRESSION
       ============================================================ */

    function _finishRound(uint _tableId, Table storage _table) internal {
        Round storage _round = rounds[_tableId][_table.currentRound];
        uint n = _round.players.length;

        if (n == 1) {
            // everyone else folded — last player wins by default
            _distributePot(_table, _tableId, _round.players[0]);
            return;
        }

        if (_allElementsEqual(_round.chips)) {
            if (_table.currentRound == 3) {
                // post-river, all bets matched → showdown
                _table.state = TableState.Showdown;
                emit ShowdownStarted(_tableId, _table.totalHands);
            } else if (_round.turn == n - 1) {
                // betting round closed → next street
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
            // someone raised — keep going around
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
       EMERGENCY — owner can refund chips if dealer crashes
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
       UTILS
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

    /* ============================================================
       VIEWS
       ============================================================ */

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
}
