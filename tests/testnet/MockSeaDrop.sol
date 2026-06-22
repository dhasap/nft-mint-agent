// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal mocks implementing the exact SeaDrop interface fast-mint.mjs calls,
// so the full competitive path (resolve -> getPublicDrop -> pre-sign mintPublic
// -> fan-out broadcast -> wait receipt) runs against real on-chain contracts.

struct PublicDrop {
    uint80 mintPrice;
    uint48 startTime;
    uint48 endTime;
    uint16 maxTotalMintableByWallet;
    uint16 feeBps;
    bool restrictFeeRecipients;
}

interface IMockNFT {
    function mintSeaDrop(address minter, uint256 quantity) external;
}

contract MockSeaDrop {
    mapping(address => PublicDrop) private _drops;

    function setPublicDrop(address nft, PublicDrop calldata d) external {
        _drops[nft] = d;
    }

    function getPublicDrop(address nft) external view returns (PublicDrop memory) {
        return _drops[nft];
    }

    function getAllowedFeeRecipients(address) external pure returns (address[] memory) {
        return new address[](0);
    }

    function getFeeRecipientIsAllowed(address, address) external pure returns (bool) {
        return true;
    }

    function mintPublic(
        address nftContract,
        address, /* feeRecipient */
        address minterIfNotPayer,
        uint256 quantity
    ) external payable {
        PublicDrop memory d = _drops[nftContract];
        require(block.timestamp >= d.startTime, "NotActive");
        require(d.endTime == 0 || block.timestamp <= d.endTime, "NotActive");
        require(msg.value >= uint256(d.mintPrice) * quantity, "IncorrectPayment");
        address minter = minterIfNotPayer == address(0) ? msg.sender : minterIfNotPayer;
        IMockNFT(nftContract).mintSeaDrop(minter, quantity);
    }
}

contract MockSeaDropNFT {
    string public name = "FastMintTest";
    string public symbol = "FMT";
    uint256 public totalSupply;
    uint256 public maxSupply = 10000;
    address public seaDrop;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public mintedBy;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    constructor(address _seaDrop) {
        seaDrop = _seaDrop;
    }

    function getMintStats(address minter)
        external
        view
        returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply_)
    {
        return (mintedBy[minter], totalSupply, maxSupply);
    }

    function mintSeaDrop(address minter, uint256 quantity) external {
        require(msg.sender == seaDrop, "only seadrop");
        for (uint256 i = 0; i < quantity; i++) {
            uint256 tid = totalSupply;
            totalSupply += 1;
            emit Transfer(address(0), minter, tid);
        }
        balanceOf[minter] += quantity;
        mintedBy[minter] += quantity;
    }
}
