import {
  OPENSEA_COLLECTION_REGEX,
  OPENSEA_ASSET_REGEX,
  CONTRACT_ADDRESS_REGEX,
  CONTRACT_ADDRESS_PATTERN,
} from '../config';

export type MintType = 'direct_contract' | 'opensea_seadrop' | 'unknown';

export interface ParsedMintInfo {
  type: MintType;
  contractAddress: string | null;
  openseaSlug: string | null;
  tokenId: string | null;
  chain: string | null;
  rawUrl: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export function parseMintLink(url: string): ParsedMintInfo {
  const result: ParsedMintInfo = {
    type: 'unknown', contractAddress: null, openseaSlug: null,
    tokenId: null, chain: null, rawUrl: url, confidence: 'low', notes: [],
  };

  // OpenSea collection URL - check for mint tab specifically
  const osCollectionMatch = url.match(OPENSEA_COLLECTION_REGEX);
  if (osCollectionMatch) {
    result.type = 'opensea_seadrop';
    result.openseaSlug = osCollectionMatch[1];
    // Higher confidence if it explicitly mentions minting
    if (url.includes('mint') || url.includes('tab=mints')) {
      result.confidence = 'high';
      result.notes.push('OpenSea collection mint page - confirmed mint intent');
    } else {
      result.confidence = 'high';
      result.notes.push('OpenSea collection URL - likely Seadrop mint');
    }
    return result;
  }

  // OpenSea asset
  const osAssetMatch = url.match(OPENSEA_ASSET_REGEX);
  if (osAssetMatch) {
    result.type = 'opensea_seadrop';
    result.chain = osAssetMatch[1];
    result.contractAddress = osAssetMatch[2];
    result.tokenId = osAssetMatch[3];
    result.confidence = 'high';
    result.notes.push('OpenSea asset URL');
    return result;
  }

  // OpenSea mint URL
  if (url.includes('opensea.io') && url.includes('mint')) {
    result.type = 'opensea_seadrop';
    result.confidence = 'medium';
    result.notes.push('OpenSea mint URL');
    const m = url.match(CONTRACT_ADDRESS_REGEX);
    if (m) result.contractAddress = m[0];
    return result;
  }

  // Seadrop/Proof
  if (url.includes('proof.xyz') || url.includes('seadrop')) {
    result.type = 'opensea_seadrop';
    const m = url.match(CONTRACT_ADDRESS_REGEX);
    if (m) result.contractAddress = m[0];
    result.confidence = 'medium';
    result.notes.push('Seadrop/Proof mint page');
    return result;
  }

  // Block explorer
  if (url.includes('etherscan.io') || url.includes('polygonscan.com') ||
      url.includes('arbiscan.io') || url.includes('basescan.org')) {
    const m = url.match(CONTRACT_ADDRESS_REGEX);
    if (m) {
      result.type = 'direct_contract';
      result.contractAddress = m[0];
      result.confidence = 'high';
      result.notes.push('Block explorer URL - direct contract');
    }
    if (url.includes('polygonscan')) result.chain = 'polygon';
    else if (url.includes('arbiscan')) result.chain = 'arbitrum';
    else if (url.includes('basescan')) result.chain = 'base';
    else result.chain = 'ethereum';
    return result;
  }

  // Thirdweb
  if (url.includes('thirdweb.com')) {
    const m = url.match(CONTRACT_ADDRESS_REGEX);
    if (m) {
      result.type = 'direct_contract';
      result.contractAddress = m[0];
      result.confidence = 'medium';
      result.notes.push('Thirdweb URL');
    }
    return result;
  }

  // Raw contract address
  if (/^0x[a-fA-F0-9]{40}$/.test(url.trim())) {
    result.type = 'direct_contract';
    result.contractAddress = url.trim();
    result.confidence = 'high';
    result.notes.push('Raw contract address');
    return result;
  }

  // Any URL with contract address
  const allMatches = url.match(CONTRACT_ADDRESS_REGEX);
  if (allMatches && allMatches.length > 0) {
    result.contractAddress = allMatches[0];
    result.type = 'direct_contract';
    result.confidence = 'medium';
    result.notes.push('Found contract address in URL');
  }

  return result;
}
