// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC internal token;

    uint256 internal buyerKey = 0xB0B0000000000000000000000000000000000000000000000000000000B0;
    address internal buyer;
    address internal merchant = address(0xDEAD1);
    address internal stranger = address(0xDEAD2);

    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        token = new MockUSDC();
        buyer = vm.addr(buyerKey);
        token.mint(buyer, 100_000_000); // 100.000000 mUSDC
    }

    function _digest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _signAuthorization(
        uint256 signerKey,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 digest = _digest(from, to, value, validAfter, validBefore, nonce);
        (v, r, s) = vm.sign(signerKey, digest);
    }

 // --- metadata ---------------------------------------------------------------------

    function test_metadata() public view {
        assertEq(token.name(), "MockUSDC");
        assertEq(token.symbol(), "mUSDC");
        assertEq(token.decimals(), 6);
        assertEq(token.version(), "2");
        assertTrue(token.DOMAIN_SEPARATOR() != bytes32(0));
    }

 // --- valid authorisation -----------------------------------------------------------

    function test_validAuthorization_transfers_and_emits() public {
        bytes32 nonce = keccak256("nonce-1");
        uint256 value = 10_000_000; // 10.000000 mUSDC
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(buyerKey, buyer, merchant, value, validAfter, validBefore, nonce);

        uint256 buyerBefore = token.balanceOf(buyer);
        uint256 merchantBefore = token.balanceOf(merchant);

        vm.expectEmit(true, true, false, false);
        emit MockUSDC.AuthorizationUsed(buyer, nonce);
        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, v, r, s);

        assertEq(token.balanceOf(buyer), buyerBefore - value);
        assertEq(token.balanceOf(merchant), merchantBefore + value);
        assertTrue(token.authorizationState(buyer, nonce));
    }

    function test_validAuthorization_bytesSignatureOverload() public {
        bytes32 nonce = keccak256("nonce-bytes");
        uint256 value = 5_000_000;
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(buyerKey, buyer, merchant, value, validAfter, validBefore, nonce);
        bytes memory signature = abi.encodePacked(r, s, v);

        uint256 buyerBefore = token.balanceOf(buyer);
        uint256 merchantBefore = token.balanceOf(merchant);

        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, signature);

        assertEq(token.balanceOf(buyer), buyerBefore - value);
        assertEq(token.balanceOf(merchant), merchantBefore + value);
    }

 // --- replay -------------------------------------------------------------------------

    function test_replayedNonce_reverts() public {
        bytes32 nonce = keccak256("nonce-replay");
        uint256 value = 1_000_000;
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(buyerKey, buyer, merchant, value, validAfter, validBefore, nonce);

        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, v, r, s);

        vm.expectRevert(MockUSDC.AuthorizationAlreadyUsed.selector);
        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, v, r, s);
    }

 // --- expiry / not-yet-valid ----------------------------------------------------------

    function test_expiredAuthorization_reverts() public {
        bytes32 nonce = keccak256("nonce-expired");
        uint256 value = 1_000_000;
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp; // already expired: block.timestamp >= validBefore

        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(buyerKey, buyer, merchant, value, validAfter, validBefore, nonce);

        vm.expectRevert(MockUSDC.AuthorizationExpired.selector);
        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, v, r, s);
    }

    function test_notYetValidAuthorization_reverts() public {
        bytes32 nonce = keccak256("nonce-not-yet-valid");
        uint256 value = 1_000_000;
        uint256 validAfter = block.timestamp + 1 days; // not yet valid: block.timestamp <= validAfter
        uint256 validBefore = block.timestamp + 2 days;

        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(buyerKey, buyer, merchant, value, validAfter, validBefore, nonce);

        vm.expectRevert(MockUSDC.AuthorizationNotYetValid.selector);
        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, v, r, s);
    }

 // --- wrong signer ---------------------------------------------------------------------

    function test_wrongSigner_reverts() public {
        bytes32 nonce = keccak256("nonce-wrong-signer");
        uint256 value = 1_000_000;
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 days;

        uint256 strangerKey = 0x51521;
 // Sign with the wrong key, but claim `buyer` as `from`.
        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(strangerKey, buyer, merchant, value, validAfter, validBefore, nonce);

        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, v, r, s);
    }

 // --- signature malleability -----------------------------------------------------------

 /// @dev secp256k1 group order — used to derive the "other" valid (v, s) pair for the same
 /// signature (s' = n - s, v' flipped), the classic ECDSA malleability trick.
    uint256 internal constant _SECP256K1N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function test_highSSignature_reverts() public {
        bytes32 nonce = keccak256("nonce-malleable");
        uint256 value = 1_000_000;
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(buyerKey, buyer, merchant, value, validAfter, validBefore, nonce);

 // vm.sign already returns the canonical low-s signature; flip to the
 // mathematically-equivalent high-s one that `ecrecover` also accepts for the same
 // digest, and that Circle's FiatTokenV2 — the ABI this mock imitates — rejects.
        bytes32 highS = bytes32(_SECP256K1N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        vm.expectRevert(MockUSDC.InvalidSignatureSValue.selector);
        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, flippedV, r, highS);
    }

    function test_highSSignature_bytesOverload_reverts() public {
        bytes32 nonce = keccak256("nonce-malleable-bytes");
        uint256 value = 1_000_000;
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(buyerKey, buyer, merchant, value, validAfter, validBefore, nonce);

        bytes32 highS = bytes32(_SECP256K1N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory signature = abi.encodePacked(r, highS, flippedV);

        vm.expectRevert(MockUSDC.InvalidSignatureSValue.selector);
        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, signature);
    }

    function test_invalidVValue_reverts() public {
        bytes32 nonce = keccak256("nonce-bad-v");
        uint256 value = 1_000_000;
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 days;

        (, bytes32 r, bytes32 s) =
            _signAuthorization(buyerKey, buyer, merchant, value, validAfter, validBefore, nonce);

        vm.expectRevert(MockUSDC.InvalidSignatureVValue.selector);
        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, 29, r, s);
    }

    function test_insufficientBalance_reverts() public {
        bytes32 nonce = keccak256("nonce-insufficient");
        uint256 value = 1_000_000_000; // way more than buyer's balance
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 s) =
            _signAuthorization(buyerKey, buyer, merchant, value, validAfter, validBefore, nonce);

        vm.expectRevert(MockUSDC.InsufficientBalance.selector);
        token.transferWithAuthorization(buyer, merchant, value, validAfter, validBefore, nonce, v, r, s);
    }
}
