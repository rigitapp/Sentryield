// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockCurvancePool is Ownable, ERC20 {
    using SafeERC20 for IERC20;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public depositBps = BPS_DENOMINATOR;
    uint16 public withdrawBps = BPS_DENOMINATOR;

    address public immutable asset;

    error InvalidBps(uint256 value);
    error InvalidAmount();
    error MinOutNotMet(uint256 amountOut, uint256 minOut);

    event SlippageBpsUpdated(uint16 depositBps, uint16 withdrawBps);
    event Deposited(address indexed caller, uint256 amountIn, uint256 sharesOut, address indexed receiver);
    event Redeemed(address indexed caller, uint256 sharesIn, uint256 amountOut, address indexed receiver);

    constructor(address owner_, address asset_, string memory name_, string memory symbol_)
        Ownable(owner_)
        ERC20(name_, symbol_)
    {
        asset = asset_;
    }

    function setSlippageBps(uint16 depositBps_, uint16 withdrawBps_) external onlyOwner {
        if (depositBps_ > BPS_DENOMINATOR) revert InvalidBps(depositBps_);
        if (withdrawBps_ > BPS_DENOMINATOR) revert InvalidBps(withdrawBps_);
        depositBps = depositBps_;
        withdrawBps = withdrawBps_;
        emit SlippageBpsUpdated(depositBps_, withdrawBps_);
    }

    function previewDeposit(uint256 assets) public view returns (uint256 shares) {
        shares = (assets * depositBps) / BPS_DENOMINATOR;
    }

    function previewRedeem(uint256 shares) public view returns (uint256 assetsOut) {
        assetsOut = (shares * withdrawBps) / BPS_DENOMINATOR;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0) revert InvalidAmount();

        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);
        shares = previewDeposit(assets);
        if (shares == 0) revert MinOutNotMet(shares, 1);

        _mint(receiver, shares);
        emit Deposited(msg.sender, assets, shares, receiver);
    }

    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assetsOut)
    {
        if (shares == 0) revert InvalidAmount();

        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        _burn(owner, shares);
        assetsOut = previewRedeem(shares);
        if (assetsOut == 0) revert MinOutNotMet(assetsOut, 1);

        IERC20(asset).safeTransfer(receiver, assetsOut);
        emit Redeemed(msg.sender, shares, assetsOut, receiver);
    }
}
