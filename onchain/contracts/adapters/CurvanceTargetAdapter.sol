// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITargetAdapter} from "../interfaces/ITargetAdapter.sol";

interface ICurvanceCToken {
    function asset() external view returns (address);

    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    function previewDeposit(uint256 assets) external view returns (uint256 shares);

    function previewRedeem(uint256 shares) external view returns (uint256 assets);
}

contract CurvanceTargetAdapter is ITargetAdapter {
    using SafeERC20 for IERC20;

    error InvalidAmount();
    error DeadlineExpired(uint256 deadline);
    error UnsupportedData();
    error UnexpectedUnderlying(address expected, address actual);
    error SlippageCheckFailed(uint256 actualOut, uint256 minOut);

    function enter(
        address pool,
        address tokenIn,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        bytes calldata data
    ) external override returns (uint256 lpReceived) {
        if (amountIn == 0) revert InvalidAmount();
        if (deadline < block.timestamp) revert DeadlineExpired(deadline);
        if (data.length != 0) revert UnsupportedData();

        ICurvanceCToken cToken = ICurvanceCToken(pool);
        address underlying = cToken.asset();
        if (underlying != tokenIn) revert UnexpectedUnderlying(tokenIn, underlying);

        uint256 previewOut = cToken.previewDeposit(amountIn);
        if (previewOut < minOut) revert SlippageCheckFailed(previewOut, minOut);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(pool, amountIn);

        lpReceived = cToken.deposit(amountIn, msg.sender);

        IERC20(tokenIn).forceApprove(pool, 0);

        if (lpReceived < minOut) {
            revert SlippageCheckFailed(lpReceived, minOut);
        }
    }

    function exit(
        address pool,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        bytes calldata data
    ) external override returns (uint256 amountOut) {
        if (amountIn == 0) revert InvalidAmount();
        if (deadline < block.timestamp) revert DeadlineExpired(deadline);
        if (data.length != 0) revert UnsupportedData();

        ICurvanceCToken cToken = ICurvanceCToken(pool);
        address underlying = cToken.asset();
        if (underlying != tokenOut) revert UnexpectedUnderlying(tokenOut, underlying);

        uint256 previewOut = cToken.previewRedeem(amountIn);
        if (previewOut < minOut) revert SlippageCheckFailed(previewOut, minOut);

        IERC20(pool).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = cToken.redeem(amountIn, msg.sender, address(this));

        if (amountOut < minOut) {
            revert SlippageCheckFailed(amountOut, minOut);
        }
    }
}
