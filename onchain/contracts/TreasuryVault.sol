// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITargetAdapter} from "./interfaces/ITargetAdapter.sol";

interface ILpValuationPool {
    function asset() external view returns (address);

    function previewRedeem(uint256 shares) external view returns (uint256 assetsOut);
}

contract TreasuryVault is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    mapping(address => bool) public tokenAllowlist;
    mapping(address => bool) public targetAllowlist;
    mapping(address => bool) public poolAllowlist;

    uint16 public movementCapBps;
    uint16 public dailyMovementCapBps;
    uint32 public maxDeadlineDelay;
    address public executor;
    address public immutable depositToken;
    uint256 public dailyMovementWindowStart;
    uint256 public dailyMovementBpsUsed;
    uint256 public totalUserShares;

    mapping(address => uint256) public userShares;
    mapping(address => bool) private trackedLpTokens;
    address[] private trackedLpTokenList;

    struct LpRoute {
        address target;
        address pool;
    }

    mapping(address => LpRoute) public lpRoutes;

    struct EnterRequest {
        address target;
        address pool;
        address tokenIn;
        address lpToken;
        uint256 amountIn;
        uint256 minOut;
        uint256 deadline;
        bytes data;
        string pair;
        string protocol;
        uint16 netApyBps;
        uint32 intendedHoldSeconds;
    }

    struct ExitRequest {
        address target;
        address pool;
        address lpToken;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        uint256 deadline;
        bytes data;
        string pair;
        string protocol;
    }

    struct RotateRequest {
        ExitRequest exitRequest;
        EnterRequest enterRequest;
        uint16 oldNetApyBps;
        uint16 newNetApyBps;
        uint8 reasonCode;
    }

    event TokenAllowlistUpdated(address indexed token, bool allowed);
    event TargetAllowlistUpdated(address indexed target, bool allowed);
    event PoolAllowlistUpdated(address indexed pool, bool allowed);
    event ExecutorUpdated(address indexed oldExecutor, address indexed newExecutor);
    event GuardianUpdated(address indexed guardian, bool enabled);
    event MovementCapBpsUpdated(uint16 bps);
    event DailyMovementCapBpsUpdated(uint16 bps);
    event MaxDeadlineDelayUpdated(uint32 maxDelaySeconds);

    event PoolEntered(
        string pair,
        string protocol,
        address indexed pool,
        uint256 amountIn,
        uint256 lpReceived,
        uint16 netApyBps,
        uint32 intendedHoldSeconds,
        uint256 timestamp
    );

    event PoolExited(
        string pair,
        string protocol,
        address indexed pool,
        uint256 lpBurned,
        uint256 amountOut,
        uint256 timestamp
    );

    event Rotated(
        address indexed fromPool,
        address indexed toPool,
        string fromPair,
        string toPair,
        uint16 oldNetApyBps,
        uint16 newNetApyBps,
        uint8 reasonCode,
        uint256 timestamp
    );

    event Paused(address indexed by, uint256 timestamp);
    event Unpaused(address indexed by, uint256 timestamp);
    event UserDeposited(address indexed user, uint256 amountIn, uint256 sharesOut, uint256 timestamp);
    event UserWithdrawn(
        address indexed user, address indexed receiver, uint256 amountOut, uint256 sharesBurned, uint256 timestamp
    );
    event LpRouteTracked(address indexed lpToken, address indexed target, address indexed pool);
    event UserWithdrawLiquidityUnwound(address indexed lpToken, uint256 lpBurned, uint256 amountOut, uint256 timestamp);

    error ZeroAddress();
    error InvalidBps(uint256 value);
    error InvalidDeadlineDelay(uint256 value);
    error InvalidAmount();
    error InvalidMinOut();
    error TokenNotAllowlisted(address token);
    error TargetNotAllowlisted(address target);
    error PoolNotAllowlisted(address pool);
    error DeadlineExpired(uint256 deadline);
    error DeadlineTooFar(uint256 deadline, uint256 maxAllowed);
    error MovementCapExceeded(address token, uint256 amount, uint256 cap);
    error DailyMovementCapExceeded(uint256 usedBps, uint256 attemptedBps, uint256 capBps);
    error InsufficientTokenBalance(address token, uint256 balance, uint256 requested);
    error TokenMismatch(address expected, address actual);
    error SlippageCheckFailed(uint256 actualOut, uint256 minOut);
    error NotGuardianOrOwner();
    error NativeTokenNotAccepted();
    error PositionStillActive();
    error InsufficientShares(uint256 balance, uint256 requested);
    error VaultHasUnaccountedAssets(uint256 currentBalance);
    error UnsupportedPoolAsset(address pool, address expected, address actual);
    error MissingLpRoute(address lpToken);
    error UnsupportedPoolPreview(address pool);
    error InsufficientLiquidityForWithdraw(uint256 available, uint256 requested);

    constructor(
        address owner_,
        address executor_,
        address guardian_,
        uint16 movementCapBps_,
        uint32 maxDeadlineDelay_,
        address depositToken_
    ) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (depositToken_ == address(0)) revert ZeroAddress();
        if (movementCapBps_ == 0 || movementCapBps_ > BPS_DENOMINATOR) revert InvalidBps(movementCapBps_);
        if (maxDeadlineDelay_ == 0) revert InvalidDeadlineDelay(maxDeadlineDelay_);

        movementCapBps = movementCapBps_;
        maxDeadlineDelay = maxDeadlineDelay_;
        depositToken = depositToken_;

        _grantRole(DEFAULT_ADMIN_ROLE, owner_);
        _grantRole(OWNER_ROLE, owner_);
        _setRoleAdmin(EXECUTOR_ROLE, OWNER_ROLE);
        _setRoleAdmin(GUARDIAN_ROLE, OWNER_ROLE);

        if (executor_ != address(0)) {
            _grantRole(EXECUTOR_ROLE, executor_);
            executor = executor_;
        }

        if (guardian_ != address(0)) {
            _grantRole(GUARDIAN_ROLE, guardian_);
        }
    }

    receive() external payable {
        revert NativeTokenNotAccepted();
    }

    function setTokenAllowlist(address token, bool allowed) external onlyRole(OWNER_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        tokenAllowlist[token] = allowed;
        emit TokenAllowlistUpdated(token, allowed);
    }

    function setTargetAllowlist(address target, bool allowed) external onlyRole(OWNER_ROLE) {
        if (target == address(0)) revert ZeroAddress();
        targetAllowlist[target] = allowed;
        emit TargetAllowlistUpdated(target, allowed);
    }

    function setPoolAllowlist(address pool, bool allowed) external onlyRole(OWNER_ROLE) {
        if (pool == address(0)) revert ZeroAddress();
        poolAllowlist[pool] = allowed;
        emit PoolAllowlistUpdated(pool, allowed);
    }

    function setExecutor(address newExecutor) external onlyRole(OWNER_ROLE) {
        if (newExecutor == address(0)) revert ZeroAddress();

        address oldExecutor = executor;
        if (oldExecutor != address(0)) {
            _revokeRole(EXECUTOR_ROLE, oldExecutor);
        }

        _grantRole(EXECUTOR_ROLE, newExecutor);
        executor = newExecutor;
        emit ExecutorUpdated(oldExecutor, newExecutor);
    }

    function setGuardian(address guardian, bool enabled) external onlyRole(OWNER_ROLE) {
        if (guardian == address(0)) revert ZeroAddress();

        if (enabled) {
            _grantRole(GUARDIAN_ROLE, guardian);
        } else {
            _revokeRole(GUARDIAN_ROLE, guardian);
        }

        emit GuardianUpdated(guardian, enabled);
    }

    function setMovementCapBps(uint16 newMovementCapBps) external onlyRole(OWNER_ROLE) {
        if (newMovementCapBps == 0 || newMovementCapBps > BPS_DENOMINATOR) revert InvalidBps(newMovementCapBps);
        movementCapBps = newMovementCapBps;
        emit MovementCapBpsUpdated(newMovementCapBps);
    }

    function setDailyMovementCapBps(uint16 newDailyMovementCapBps) external onlyRole(OWNER_ROLE) {
        if (newDailyMovementCapBps > BPS_DENOMINATOR) revert InvalidBps(newDailyMovementCapBps);
        dailyMovementCapBps = newDailyMovementCapBps;
        emit DailyMovementCapBpsUpdated(newDailyMovementCapBps);
    }

    function setMaxDeadlineDelay(uint32 newMaxDeadlineDelay) external onlyRole(OWNER_ROLE) {
        if (newMaxDeadlineDelay == 0) revert InvalidDeadlineDelay(newMaxDeadlineDelay);
        maxDeadlineDelay = newMaxDeadlineDelay;
        emit MaxDeadlineDelayUpdated(newMaxDeadlineDelay);
    }

    function pause() external {
        bool isGuardian = hasRole(GUARDIAN_ROLE, msg.sender);
        bool isOwner = hasRole(OWNER_ROLE, msg.sender);
        if (!isGuardian && !isOwner) revert NotGuardianOrOwner();
        _pause();
        emit Paused(msg.sender, block.timestamp);
    }

    function unpause() external onlyRole(OWNER_ROLE) {
        _unpause();
        emit Unpaused(msg.sender, block.timestamp);
    }

    function hasOpenLpPosition() public view returns (bool) {
        for (uint256 i = 0; i < trackedLpTokenList.length; i++) {
            if (IERC20(trackedLpTokenList[i]).balanceOf(address(this)) > 0) {
                return true;
            }
        }
        return false;
    }

    function supportsAnytimeLiquidity() external pure returns (bool) {
        return true;
    }

    function totalAssets() public view returns (uint256 assetsOut) {
        assetsOut = IERC20(depositToken).balanceOf(address(this));
        for (uint256 i = 0; i < trackedLpTokenList.length; i++) {
            address lpToken = trackedLpTokenList[i];
            uint256 lpBalance = IERC20(lpToken).balanceOf(address(this));
            if (lpBalance == 0) continue;
            assetsOut += _previewRedeemAssets(lpToken, lpBalance);
        }
    }

    function convertToShares(uint256 assetsIn) public view returns (uint256 sharesOut) {
        if (assetsIn == 0) return 0;
        uint256 totalShares = totalUserShares;
        if (totalShares == 0) return assetsIn;

        uint256 assets = totalAssets();
        if (assets == 0) return 0;
        sharesOut = (assetsIn * totalShares) / assets;
    }

    function convertToAssets(uint256 sharesIn) public view returns (uint256 assetsOut) {
        if (sharesIn == 0) return 0;
        uint256 totalShares = totalUserShares;
        if (totalShares == 0) return 0;
        assetsOut = (sharesIn * totalAssets()) / totalShares;
    }

    function maxWithdrawToWallet(address account) public view returns (uint256 assetsOut) {
        uint256 shares = userShares[account];
        if (shares == 0 || totalUserShares == 0) return 0;
        assetsOut = convertToAssets(shares);
    }

    function previewWithdrawToWallet(uint256 assetsOut) public view returns (uint256 sharesBurned) {
        if (assetsOut == 0) return 0;
        uint256 idleBalance = totalAssets();
        uint256 totalShares = totalUserShares;
        if (idleBalance == 0 || totalShares == 0) return 0;
        sharesBurned = ((assetsOut * totalShares) + (idleBalance - 1)) / idleBalance;
    }

    function depositUsdc(uint256 amountIn) external whenNotPaused nonReentrant returns (uint256 sharesOut) {
        if (amountIn == 0) revert InvalidAmount();

        _requireTokenAllowed(depositToken);
        uint256 assetsBefore = totalAssets();
        if (totalUserShares == 0) {
            if (assetsBefore != 0) revert VaultHasUnaccountedAssets(assetsBefore);
            sharesOut = amountIn;
        } else {
            if (assetsBefore == 0) revert InvalidAmount();
            sharesOut = (amountIn * totalUserShares) / assetsBefore;
            if (sharesOut == 0) revert InvalidAmount();
        }

        IERC20(depositToken).safeTransferFrom(msg.sender, address(this), amountIn);
        userShares[msg.sender] += sharesOut;
        totalUserShares += sharesOut;

        emit UserDeposited(msg.sender, amountIn, sharesOut, block.timestamp);
    }

    function withdrawToWallet(uint256 amountOut, address receiver)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 sharesBurned)
    {
        if (amountOut == 0) revert InvalidAmount();
        if (receiver == address(0)) revert ZeroAddress();

        sharesBurned = previewWithdrawToWallet(amountOut);
        if (sharesBurned == 0) revert InvalidAmount();

        uint256 currentShares = userShares[msg.sender];
        if (sharesBurned > currentShares) {
            revert InsufficientShares(currentShares, sharesBurned);
        }

        _ensureIdleLiquidityForWithdraw(amountOut);

        userShares[msg.sender] = currentShares - sharesBurned;
        totalUserShares -= sharesBurned;
        IERC20(depositToken).safeTransfer(receiver, amountOut);

        emit UserWithdrawn(msg.sender, receiver, amountOut, sharesBurned, block.timestamp);
    }

    function enterPool(EnterRequest calldata request)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 lpReceived)
    {
        EnterRequest memory requestCopy = request;
        lpReceived = _enterPool(requestCopy);
    }

    function exitPool(ExitRequest calldata request)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        ExitRequest memory requestCopy = request;
        amountOut = _exitPool(requestCopy);
    }

    function rotate(RotateRequest calldata request)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut, uint256 lpReceived)
    {
        ExitRequest memory exitReq = request.exitRequest;
        EnterRequest memory enterReq = request.enterRequest;
        _requirePoolAllowed(exitReq.pool);
        _requirePoolAllowed(enterReq.pool);

        amountOut = _exitPool(exitReq);

        if (enterReq.amountIn == 0) {
            if (enterReq.tokenIn != exitReq.tokenOut) {
                revert TokenMismatch(exitReq.tokenOut, enterReq.tokenIn);
            }
            enterReq.amountIn = amountOut;
        }

        lpReceived = _enterPool(enterReq);

        emit Rotated(
            exitReq.pool,
            enterReq.pool,
            exitReq.pair,
            enterReq.pair,
            request.oldNetApyBps,
            request.newNetApyBps,
            request.reasonCode,
            block.timestamp
        );
    }

    function _enterPool(EnterRequest memory request) internal returns (uint256 lpReceived) {
        if (request.amountIn == 0) revert InvalidAmount();
        if (request.minOut == 0) revert InvalidMinOut();
        if (request.tokenIn != depositToken) revert TokenMismatch(depositToken, request.tokenIn);

        _requireTokenAllowed(request.tokenIn);
        _requireTokenAllowed(request.lpToken);
        _requireTargetAllowed(request.target);
        _requirePoolAllowed(request.pool);
        _requireTargetAllowed(request.pool);
        _validateDeadline(request.deadline);
        _enforceMovementCaps(request.tokenIn, request.amountIn);

        _trackLpToken(request.lpToken, request.target, request.pool);
        IERC20(request.tokenIn).forceApprove(request.target, request.amountIn);

        lpReceived = ITargetAdapter(request.target).enter(
            request.pool, request.tokenIn, request.amountIn, request.minOut, request.deadline, request.data
        );

        if (lpReceived < request.minOut) {
            revert SlippageCheckFailed(lpReceived, request.minOut);
        }

        IERC20(request.tokenIn).forceApprove(request.target, 0);

        emit PoolEntered(
            request.pair,
            request.protocol,
            request.pool,
            request.amountIn,
            lpReceived,
            request.netApyBps,
            request.intendedHoldSeconds,
            block.timestamp
        );
    }

    function _exitPool(ExitRequest memory request) internal returns (uint256 amountOut) {
        if (request.amountIn == 0) revert InvalidAmount();
        if (request.minOut == 0) revert InvalidMinOut();
        if (request.tokenOut != depositToken) revert TokenMismatch(depositToken, request.tokenOut);

        _requireTokenAllowed(request.lpToken);
        _requireTokenAllowed(request.tokenOut);
        _requireTargetAllowed(request.target);
        _requirePoolAllowed(request.pool);
        _requireTargetAllowed(request.pool);
        _validateDeadline(request.deadline);
        _enforceMovementCaps(request.lpToken, request.amountIn);

        IERC20(request.lpToken).forceApprove(request.target, request.amountIn);

        amountOut =
            ITargetAdapter(request.target).exit(request.pool, request.tokenOut, request.amountIn, request.minOut, request.deadline, request.data);

        if (amountOut < request.minOut) {
            revert SlippageCheckFailed(amountOut, request.minOut);
        }

        IERC20(request.lpToken).forceApprove(request.target, 0);

        emit PoolExited(request.pair, request.protocol, request.pool, request.amountIn, amountOut, block.timestamp);
    }

    function _requireTokenAllowed(address token) internal view {
        if (!tokenAllowlist[token]) revert TokenNotAllowlisted(token);
    }

    function _requireTargetAllowed(address target) internal view {
        if (!targetAllowlist[target]) revert TargetNotAllowlisted(target);
    }

    function _requirePoolAllowed(address pool) internal view {
        if (!poolAllowlist[pool]) revert PoolNotAllowlisted(pool);
    }

    function _validateDeadline(uint256 deadline) internal view {
        if (deadline < block.timestamp) revert DeadlineExpired(deadline);

        uint256 maxAllowed = block.timestamp + uint256(maxDeadlineDelay);
        if (deadline > maxAllowed) revert DeadlineTooFar(deadline, maxAllowed);
    }

    function _enforceMovementCaps(address token, uint256 amount) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (amount > balance) revert InsufficientTokenBalance(token, balance, amount);

        uint256 cap = (balance * movementCapBps) / BPS_DENOMINATOR;
        if (amount > cap) revert MovementCapExceeded(token, amount, cap);

        _consumeDailyMovementBudget(balance, amount);
    }

    function _consumeDailyMovementBudget(uint256 balance, uint256 amount) internal {
        uint16 capBps = dailyMovementCapBps;
        if (capBps == 0) {
            return;
        }

        uint256 windowStart = dailyMovementWindowStart;
        if (windowStart == 0 || block.timestamp >= windowStart + 1 days) {
            dailyMovementWindowStart = block.timestamp;
            dailyMovementBpsUsed = 0;
        }

        // Use a conservative ceil division so tiny movements still consume budget.
        uint256 attemptedBps = ((amount * BPS_DENOMINATOR) + (balance - 1)) / balance;
        uint256 nextUsed = dailyMovementBpsUsed + attemptedBps;
        if (nextUsed > capBps) {
            revert DailyMovementCapExceeded(dailyMovementBpsUsed, attemptedBps, capBps);
        }

        dailyMovementBpsUsed = nextUsed;
    }

    function _ensureIdleLiquidityForWithdraw(uint256 amountOut) internal {
        uint256 idleBalance = IERC20(depositToken).balanceOf(address(this));
        if (idleBalance >= amountOut) return;

        _unwindForWithdraw(amountOut - idleBalance);

        uint256 updatedIdle = IERC20(depositToken).balanceOf(address(this));
        if (updatedIdle < amountOut) {
            revert InsufficientLiquidityForWithdraw(updatedIdle, amountOut);
        }
    }

    function _unwindForWithdraw(uint256 amountNeeded) internal {
        uint256 recovered;
        for (uint256 i = 0; i < trackedLpTokenList.length && recovered < amountNeeded; i++) {
            address lpToken = trackedLpTokenList[i];
            uint256 lpBalance = IERC20(lpToken).balanceOf(address(this));
            if (lpBalance == 0) continue;

            uint256 totalPreviewAssets = _previewRedeemAssets(lpToken, lpBalance);
            if (totalPreviewAssets == 0) continue;

            uint256 remainingAssets = amountNeeded - recovered;
            uint256 lpToRedeem = ((remainingAssets * lpBalance) + (totalPreviewAssets - 1)) / totalPreviewAssets;
            if (lpToRedeem > lpBalance) {
                lpToRedeem = lpBalance;
            }

            lpToRedeem = _resolveCappedMovementAmount(lpToken, lpToRedeem);
            if (lpToRedeem == 0) continue;

            ExitRequest memory autoExit = _buildAutoExitRequest(lpToken, lpToRedeem);
            uint256 amountOut = _exitPool(autoExit);
            recovered += amountOut;

            emit UserWithdrawLiquidityUnwound(lpToken, lpToRedeem, amountOut, block.timestamp);
        }
    }

    function _buildAutoExitRequest(address lpToken, uint256 amountIn) internal view returns (ExitRequest memory request) {
        LpRoute memory route = lpRoutes[lpToken];
        if (route.target == address(0) || route.pool == address(0)) revert MissingLpRoute(lpToken);

        request.target = route.target;
        request.pool = route.pool;
        request.lpToken = lpToken;
        request.tokenOut = depositToken;
        request.amountIn = amountIn;
        request.minOut = 1;
        request.deadline = block.timestamp + uint256(maxDeadlineDelay);
        request.data = bytes("");
        request.pair = "";
        request.protocol = "auto_withdraw_unwind";
    }

    function _resolveCappedMovementAmount(address token, uint256 requestedAmount) internal view returns (uint256) {
        if (requestedAmount == 0) return 0;
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return 0;

        uint256 movementCap = (balance * movementCapBps) / BPS_DENOMINATOR;
        uint256 allowed = movementCap > 0 ? movementCap : balance;
        if (allowed > balance) {
            allowed = balance;
        }
        if (requestedAmount < allowed) {
            allowed = requestedAmount;
        }

        uint16 capBps = dailyMovementCapBps;
        if (capBps == 0) {
            return allowed;
        }

        uint256 windowStart = dailyMovementWindowStart;
        if (windowStart != 0 && block.timestamp < windowStart + 1 days) {
            uint256 usedBps = dailyMovementBpsUsed;
            if (usedBps >= capBps) {
                return 0;
            }
            uint256 remainingBps = uint256(capBps) - usedBps;
            uint256 allowedByDaily = (balance * remainingBps) / BPS_DENOMINATOR;
            if (allowedByDaily == 0) {
                return 0;
            }
            if (allowed > allowedByDaily) {
                allowed = allowedByDaily;
            }
        }

        return allowed;
    }

    function _previewRedeemAssets(address lpToken, uint256 lpAmount) internal view returns (uint256 assetsOut) {
        if (lpAmount == 0) return 0;
        LpRoute memory route = lpRoutes[lpToken];
        if (route.pool == address(0)) revert MissingLpRoute(lpToken);
        try ILpValuationPool(route.pool).previewRedeem(lpAmount) returns (uint256 previewOut) {
            return previewOut;
        } catch {
            revert UnsupportedPoolPreview(route.pool);
        }
    }

    function _validatePoolAsset(address pool) internal view {
        try ILpValuationPool(pool).asset() returns (address assetToken) {
            if (assetToken != depositToken) {
                revert UnsupportedPoolAsset(pool, depositToken, assetToken);
            }
        } catch {
            revert UnsupportedPoolPreview(pool);
        }
    }

    function _trackLpToken(address lpToken, address target, address pool) internal {
        if (lpToken == address(0) || target == address(0) || pool == address(0)) revert ZeroAddress();
        if (!trackedLpTokens[lpToken]) {
            trackedLpTokens[lpToken] = true;
            trackedLpTokenList.push(lpToken);
        }

        _validatePoolAsset(pool);
        LpRoute storage route = lpRoutes[lpToken];
        if (route.target != target || route.pool != pool) {
            route.target = target;
            route.pool = pool;
            emit LpRouteTracked(lpToken, target, pool);
        }
    }
}
