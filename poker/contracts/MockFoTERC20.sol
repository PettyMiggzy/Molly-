// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * MockFoTERC20 — takes `feeBps` (default 100 = 1%) out of every transfer.
 * Sends the fee to address(1) to keep the math testable; toggles the
 * fee on/off via setFeeBps so a single test can exercise both branches.
 */
contract MockFoTERC20 is ERC20 {
    address constant FEE_SINK = address(1);
    uint public feeBps = 100; // 1%

    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint amount) external { _mint(to, amount); }

    function setFeeBps(uint _bps) external {
        require(_bps <= 10_000, "bps too high");
        feeBps = _bps;
    }

    function _update(address from, address to, uint value) internal override {
        // Skip fee on mint (from == 0) and burn (to == 0)
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint fee = (value * feeBps) / 10_000;
            if (fee > 0) {
                super._update(from, FEE_SINK, fee);
                value -= fee;
            }
        }
        super._update(from, to, value);
    }
}
