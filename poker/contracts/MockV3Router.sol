// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IExactInputSingleRouter {
    // Matches Uniswap V3 SwapRouter02 — no `deadline` field.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
}

contract MockV3Router {
    struct Recorded {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    Recorded[] public recorded;
    uint public rateOut = 1e18;

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
            amountIn: p.amountIn,
            amountOutMinimum: p.amountOutMinimum,
            sqrtPriceLimitX96: p.sqrtPriceLimitX96
        }));
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = rateOut;
        IERC20(p.tokenOut).transfer(p.recipient, amountOut);
    }
}
