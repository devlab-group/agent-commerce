// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title MockUSDC — EIP-3009 test token for the Agent Commerce local demo chain.
/// @notice THIS IS A TEST TOKEN. It has an unrestricted `mint` function and must never be
/// deployed anywhere but the deterministic local Anvil chain. Do not fund any address that
/// holds real value with this contract's address.
///
/// Implements a minimal ERC-20 plus EIP-3009 `transferWithAuthorization`, matching the
/// subset of Circle's FiatTokenV2 ABI that the pinned x402 SDK (version 1.2.0) expects: both
/// the `(v,r,s)` EOA-signature overload and the `(bytes signature)` overload, because the SDK
/// selects between them by signature length.
contract MockUSDC {
    // --- ERC-20 metadata -----------------------------------------------------------------

    string public constant name = "MockUSDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    // --- EIP-712 domain --------------------------------------------------------------------

    /// @dev EIP-712 domain version. Distinct from `decimals` — this is the token contract's
    /// signing-domain version, matching x402's `requirements.extra.version`.
    string public constant version = "2";

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    // --- ERC-20 state ----------------------------------------------------------------------

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // --- EIP-3009 state --------------------------------------------------------------------

    /// @dev authorizer => nonce => used
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    // --- events --------------------------------------------------------------------------

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    // --- errors --------------------------------------------------------------------------

    error InsufficientBalance();
    error InsufficientAllowance();
    error AuthorizationAlreadyUsed();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error InvalidSignature();
    error ZeroAddress();

    // --- signature malleability ------------------------------------------------------------

    /// @dev secp256k1n / 2 — the OpenZeppelin ECDSA.sol bound. `ecrecover` accepts both `s`
    /// and `n - s` for the same message (the "other" valid signature for that message,
    /// producing the same address), so a token that checks nothing here lets an authorization
    /// be resubmitted with an equally-valid, differently-encoded signature. This mock imitates
    /// Circle's FiatTokenV2 ABI (see the contract-level docs above) — FiatTokenV2 rejects
    /// high-`s` signatures, so this mock must too, or "works on the local demo" would not
    /// prove anything about the real token it stands in for. There is no exploit against
    /// *this* project today (replay is keyed on `(from, nonce)`, not the signature, per
    /// docs/contracts.md), but divergence from the imitated ABI is itself the bug.
    uint256 private constant _SECP256K1N_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    error InvalidSignatureSValue();
    error InvalidSignatureVValue();

    function _requireNonMalleableSignature(uint8 v, bytes32 s) private pure {
        if (uint256(s) > _SECP256K1N_HALF) revert InvalidSignatureSValue();
        if (v != 27 && v != 28) revert InvalidSignatureVValue();
    }

    // --- ERC-20 --------------------------------------------------------------------------

    /// @notice Unrestricted mint. TEST TOKEN ONLY — never deploy this to a network with real value.
    function mint(address to, uint256 amount) external {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < value) revert InsufficientAllowance();
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 fromBalance = balanceOf[from];
        if (fromBalance < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = fromBalance - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    // --- EIP-712 ---------------------------------------------------------------------------

    /// @notice Per-call domain separator, recomputed from the live chain id so the contract
    /// works correctly regardless of which chain it is deployed to (no constructor-cached
    /// domain separator that would go stale under `--chain-id`).
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _EIP712_DOMAIN_TYPEHASH,
                    keccak256(bytes(name)),
                    keccak256(bytes(version)),
                    block.chainid,
                    address(this)
                )
            );
    }

    // --- EIP-3009 --------------------------------------------------------------------------

    /// @notice EOA-signature overload — the path the demo / x402 SDK uses for local accounts.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _requireNonMalleableSignature(v, s);
        bytes32 digest = _authorizationDigest(
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce
        );
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != from) revert InvalidSignature();
        _executeAuthorization(from, to, value, validAfter, validBefore, nonce);
    }

    /// @notice Smart-wallet / arbitrary-signature overload. Only plain ECDSA (65-byte)
    /// signatures are supported by this test token — ERC-1271 contract signatures are out of
    /// scope for the alpha demo, which uses EOA buyer keys exclusively.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        _requireNonMalleableSignature(v, s);
        bytes32 digest = _authorizationDigest(
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce
        );
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != from) revert InvalidSignature();
        _executeAuthorization(from, to, value, validAfter, validBefore, nonce);
    }

    function _authorizationDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        return
            keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash)
            );
    }

    function _executeAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) private {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        _transfer(from, to, value);
    }
}
