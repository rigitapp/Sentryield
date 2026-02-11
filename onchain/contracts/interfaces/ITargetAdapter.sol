// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITargetAdapter {
    function enter(
        address pool,
        address tokenIn,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        bytes calldata data
    ) external returns (uint256 amountOut);

    function exit(
        address pool,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        bytes calldata data
    ) external returns (uint256 amountOut);
}
