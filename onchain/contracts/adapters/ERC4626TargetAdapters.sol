// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITargetAdapter} from "../interfaces/ITargetAdapter.sol";

interface IERC4626Vault {
    function asset() external view returns (address);

    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    function previewDeposit(uint256 assets) external view returns (uint256 shares);

    function previewRedeem(uint256 shares) external view returns (uint256 assets);
}

interface IAaveV3Pool {
    struct ReserveData {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address asset) external view returns (ReserveData memory data);

    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function withdraw(address asset, uint256 amount, address to) external returns (uint256 amountOut);
}

contract ERC4626TargetAdapter is ITargetAdapter {
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
    ) external virtual override returns (uint256 lpReceived) {
        if (amountIn == 0) revert InvalidAmount();
        if (deadline < block.timestamp) revert DeadlineExpired(deadline);
        if (data.length != 0) revert UnsupportedData();

        IERC4626Vault vault = IERC4626Vault(pool);
        address underlying = vault.asset();
        if (underlying != tokenIn) revert UnexpectedUnderlying(tokenIn, underlying);

        uint256 previewOut = vault.previewDeposit(amountIn);
        if (previewOut < minOut) revert SlippageCheckFailed(previewOut, minOut);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(pool, amountIn);

        lpReceived = vault.deposit(amountIn, msg.sender);

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
    ) external virtual override returns (uint256 amountOut) {
        if (amountIn == 0) revert InvalidAmount();
        if (deadline < block.timestamp) revert DeadlineExpired(deadline);
        if (data.length != 0) revert UnsupportedData();

        IERC4626Vault vault = IERC4626Vault(pool);
        address underlying = vault.asset();
        if (underlying != tokenOut) revert UnexpectedUnderlying(tokenOut, underlying);

        uint256 previewOut = vault.previewRedeem(amountIn);
        if (previewOut < minOut) revert SlippageCheckFailed(previewOut, minOut);

        IERC20(pool).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = vault.redeem(amountIn, msg.sender, address(this));

        if (amountOut < minOut) {
            revert SlippageCheckFailed(amountOut, minOut);
        }
    }
}

contract MorphoTargetAdapter is ERC4626TargetAdapter {}

contract GearboxTargetAdapter is ERC4626TargetAdapter {}

contract TownSquareTargetAdapter is ERC4626TargetAdapter {}

contract NeverlandTargetAdapter is ITargetAdapter {
    using SafeERC20 for IERC20;

    error InvalidAmount();
    error DeadlineExpired(uint256 deadline);
    error UnsupportedData();
    error UnknownReserve(address token);
    error UnexpectedAToken(address expected, address actual);
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

        address expectedAToken = _decodeExpectedAToken(data);
        IAaveV3Pool aavePool = IAaveV3Pool(pool);
        IAaveV3Pool.ReserveData memory reserveData = aavePool.getReserveData(tokenIn);
        address aToken = reserveData.aTokenAddress;
        if (aToken == address(0)) revert UnknownReserve(tokenIn);
        if (expectedAToken != address(0) && aToken != expectedAToken) {
            revert UnexpectedAToken(expectedAToken, aToken);
        }

        uint256 beforeBalance = IERC20(aToken).balanceOf(msg.sender);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(pool, amountIn);
        aavePool.supply(tokenIn, amountIn, msg.sender, 0);
        IERC20(tokenIn).forceApprove(pool, 0);

        uint256 afterBalance = IERC20(aToken).balanceOf(msg.sender);
        lpReceived = afterBalance - beforeBalance;
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

        address expectedAToken = _decodeExpectedAToken(data);
        IAaveV3Pool aavePool = IAaveV3Pool(pool);
        IAaveV3Pool.ReserveData memory reserveData = aavePool.getReserveData(tokenOut);
        address aToken = reserveData.aTokenAddress;
        if (aToken == address(0)) revert UnknownReserve(tokenOut);
        if (expectedAToken != address(0) && aToken != expectedAToken) {
            revert UnexpectedAToken(expectedAToken, aToken);
        }

        IERC20(aToken).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = aavePool.withdraw(tokenOut, amountIn, msg.sender);
        if (amountOut < minOut) {
            revert SlippageCheckFailed(amountOut, minOut);
        }
    }

    function _decodeExpectedAToken(bytes calldata data) private pure returns (address expectedAToken) {
        if (data.length == 0) return address(0);
        if (data.length != 32) revert UnsupportedData();
        expectedAToken = abi.decode(data, (address));
    }
}
