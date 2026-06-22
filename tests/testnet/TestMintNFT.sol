// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal mintable ERC-721-ish test contract for nft-mint-agent end-to-end testing.
/// Exposes the read methods detect_contract probes (name/symbol/totalSupply/maxSupply/
/// mintPrice/maxPerWallet) and a public `mint(uint256)` payable function.
contract TestMintNFT {
    string public name = "TestMintNFT";
    string public symbol = "TMN";
    uint256 public totalSupply;
    uint256 public maxSupply = 10000;
    uint256 public mintPrice = 0.001 ether;
    uint256 public maxPerWallet = 20;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function mint(uint256 quantity) external payable {
        require(quantity > 0, "qty=0");
        require(msg.value >= mintPrice * quantity, "insufficient payment");
        require(balanceOf[msg.sender] + quantity <= maxPerWallet, "exceeds maxPerWallet");
        require(totalSupply + quantity <= maxSupply, "exceeds maxSupply");
        for (uint256 i = 0; i < quantity; i++) {
            uint256 tid = totalSupply;
            ownerOf[tid] = msg.sender;
            totalSupply += 1;
            emit Transfer(address(0), msg.sender, tid);
        }
        balanceOf[msg.sender] += quantity;
    }
}
