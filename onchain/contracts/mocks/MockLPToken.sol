// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockLPToken is ERC20, Ownable {
    address public pool;

    error OnlyPool();
    error ZeroAddress();
    error PoolAlreadySet();

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    constructor(string memory name_, string memory symbol_, address owner_) ERC20(name_, symbol_) Ownable(owner_) {}

    function setPool(address pool_) external onlyOwner {
        if (pool_ == address(0)) revert ZeroAddress();
        if (pool != address(0)) revert PoolAlreadySet();
        pool = pool_;
    }

    function mint(address to, uint256 amount) external onlyPool {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyPool {
        _burn(from, amount);
    }
}
