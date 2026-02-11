// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITargetAdapter} from "../../interfaces/ITargetAdapter.sol";

abstract contract NotImplementedTargetAdapter is ITargetAdapter {
    error NotImplemented();

    function enter(address, address, uint256, uint256, uint256, bytes calldata)
        external
        pure
        virtual
        override
        returns (uint256)
    {
        revert NotImplemented();
    }

    function exit(address, address, uint256, uint256, uint256, bytes calldata)
        external
        pure
        virtual
        override
        returns (uint256)
    {
        revert NotImplemented();
    }
}

/// @notice TODO: implement real Morpho integration (vault deposit/withdraw route).
contract MorphoTargetAdapterStub is NotImplementedTargetAdapter {}

/// @notice TODO: implement real Gearbox integration.
contract GearboxTargetAdapterStub is NotImplementedTargetAdapter {}

/// @notice TODO: implement real TownSquare integration.
contract TownSquareTargetAdapterStub is NotImplementedTargetAdapter {}

/// @notice TODO: implement real Neverland integration.
contract NeverlandTargetAdapterStub is NotImplementedTargetAdapter {}
