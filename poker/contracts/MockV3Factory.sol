// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * MockV3Factory — minimal IUniswapV3Factory implementation for tests.
 *
 * Lets the test set whether a (tokenA, tokenB, fee) tuple has a pool by
 * calling setPool. createTable consults this to decide if a token has
 * "graduated" (has a real V3 pool against WMON).
 */
contract MockV3Factory {
    mapping(bytes32 => address) public pools;

    function _key(address tokenA, address tokenB, uint24 fee) internal pure returns (bytes32) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encodePacked(t0, t1, fee));
    }

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        pools[_key(tokenA, tokenB, fee)] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[_key(tokenA, tokenB, fee)];
    }
}
