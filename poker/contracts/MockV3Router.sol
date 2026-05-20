// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IExactInputSingleRouter {
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
}

/**
 * MockV3Router — records every call to exactInputSingle so tests can verify:
 *   - Whether the swap was actually invoked (we expect it NOT to be on fold-wins,
 *     per audit M1 pass-2 fix)
 *   - What amountOutMinimum was passed (we expect > 0 on showdown wins)
 *
 * Pulls tokenIn from caller, transfers tokenOut to recipient at the configured rate.
 * Test must mint WMON to this contract before calling so it has something to give back.
 */
contract MockV3Router {
    struct Recorded {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    Recorded[] public recorded;
    uint public rateOut = 1e18; // amount of tokenOut sent per swap (constant; tests can override)

    function setRateOut(uint _r) external { rateOut = _r; }
    function callCount() external view returns (uint) { return recorded.length; }

    function exactInputSingle(IExactInputSingleRouter.ExactInputSingleParams calldata p)
        external
        returns (uint amountOut)
    {
        recorded.push(Recorded({
            tokenIn: p.tokenIn,
            tokenOut: p.tokenOut,
            fee: p.fee,
            recipient: p.recipient,
            deadline: p.deadline,
            amountIn: p.amountIn,
            amountOutMinimum: p.amountOutMinimum,
            sqrtPriceLimitX96: p.sqrtPriceLimitX96
        }));
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = rateOut;
        IERC20(p.tokenOut).transfer(p.recipient, amountOut);
    }
}
