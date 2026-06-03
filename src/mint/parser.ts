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
  // BUG-018 FIX: Strip URL fragments (#) and query params (?) before matching
  // This prevents issues like "https://example.com/mint#section" not matching
  let cleanUrl = url;
  try {
    const parsed = new URL(url);
    cleanUrl = parsed.origin + parsed.pathname;
  } catch {
    // Not a valid URL — try manual strip
    cleanUrl = url.split('?')[0].split('#')[0];
  }

  const result: ParsedMintInfo = {
    type: 'unknown', contractAddress: null, openseaSlug: null,
    tokenId: null, chain: null, rawUrl: url, confidence: 'low', notes: [],
  };

  // OpenSea collection URL - check for mint tab specifically
  const osCollectionMatch = cleanUrl.match(OPENSEA_COLLECTION_REGEX);
  if (osCollectionMatch) {
    result.type = 'opensea_seadrop';
    result.openseaSlug = osCollectionMatch[1];
    // Higher confidence if it explicitly mentions minting
    if (cleanUrl.includes('mint') || url.includes('tab=mints')) {
      result.confidence = 'high';
      result.notes.push('OpenSea collection mint page - confirmed mint intent');
    } else {
      result.confidence = 'high';
      result.notes.push('OpenSea collection URL - likely Seadrop mint');
    }
    return result;
  }

  // OpenSea asset
  const osAssetMatch = cleanUrl.match(OPENSEA_ASSET_REGEX);
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
  if (cleanUrl.includes('opensea.io') && cleanUrl.includes('mint')) {
    result.type = 'opensea_seadrop';
    result.confidence = 'medium';
    result.notes.push('OpenSea mint URL');
    const m = cleanUrl.match(CONTRACT_ADDRESS_REGEX);
    if (m) result.contractAddress = m[0];
    return result;
  }

  // Seadrop/Proof
  if (cleanUrl.includes('proof.xyz') || cleanUrl.includes('seadrop')) {
    result.type = 'opensea_seadrop';
    const m = cleanUrl.match(CONTRACT_ADDRESS_REGEX);
    if (m) result.contractAddress = m[0];
    result.confidence = 'medium';
    result.notes.push('Seadrop/Proof mint page');
    return result;
  }

  // Block explorer
  if (cleanUrl.includes('etherscan.io') || cleanUrl.includes('polygonscan.com') ||
      cleanUrl.includes('arbiscan.io') || cleanUrl.includes('basescan.org')) {
    const m = cleanUrl.match(CONTRACT_ADDRESS_REGEX);
    if (m) {
      result.type = 'direct_contract';
      result.contractAddress = m[0];
      result.confidence = 'high';
      result.notes.push('Block explorer URL - direct contract');
    }
    if (cleanUrl.includes('polygonscan')) result.chain = 'polygon';
    else if (cleanUrl.includes('arbiscan')) result.chain = 'arbitrum';
    else if (cleanUrl.includes('basescan')) result.chain = 'base';
    else result.chain = 'ethereum';
    return result;
  }

  // Thirdweb
  if (cleanUrl.includes('thirdweb.com')) {
    const m = cleanUrl.match(CONTRACT_ADDRESS_REGEX);
    if (m) {
      result.type = 'direct_contract';
      result.contractAddress = m[0];
      result.confidence = 'medium';
      result.notes.push('Thirdweb URL');
    }
    return result;
  }

  // Raw contract address
  if (/^0x[a-fA-F0-9]{40}$/.test(cleanUrl.trim())) {
    result.type = 'direct_contract';
    result.contractAddress = cleanUrl.trim();
    result.confidence = 'high';
    result.notes.push('Raw contract address');
    return result;
  }

  // Any URL with contract address
  const allMatches = cleanUrl.match(CONTRACT_ADDRESS_REGEX);
  if (allMatches && allMatches.length > 0) {
    result.contractAddress = allMatches[0];
    result.type = 'direct_contract';
    result.confidence = 'medium';
    result.notes.push('Found contract address in URL');
  }

  return result;
}
