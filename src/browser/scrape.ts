/**
 * Browser Scraping - Extract contract addresses from NFT mint websites
 *
 * Strategy:
 * 1. Server-side: fetch HTML, regex for contract addresses
 * 2. If SPA / not found: generate browser console scripts for agent to use
 *
 * The agent can evaluate these scripts via browser_console() in Hermes.
 */

import axios from 'axios';
import { CONTRACT_ADDRESS_PATTERN } from '../config';

// --- Result Types ---

export interface ScrapeResult {
  url: string;
  contractAddresses: ScrapeAddress[];
  chain: string | null;
  method: 'server_fetch' | 'browser_needed';
  browserScript: string | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export interface ScrapeAddress {
  address: string;
  context: string;    // surrounding text for context
  source: string;     // where we found it (html, meta, script, config)
  isLikelyNFT: boolean;
}

// --- Excluded Addresses ---

const EXCLUDED_LOWERCASE = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x0000000000000000000000000000000000000001',
  '0x000000000000000000000000000000000000dead',
  // Seadrop
  '0x00005ea67ac36d4aa7f7be4d33385971bae75dee',
  // Common tokens
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
  // OpenSea Seaport
  '0x00000000006c3852cbef3e08e8df289169ede581',
  // Conduit
  '0x1e0049783f008a00821988e40234801405c5f856',
  // ENS
  '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85',
  // Proxy registry
  '0xa5409ec958c83c3f309868babaca7c86dcb077c1',
]);

// NFT context keywords
const NFT_KEYWORDS = /nft|mint|collection|token|supply|claim|drop|reveal|presale|allowlist|whitelist|public.sale|erc721|erc1155|seadrop|opensea|floor|metadata|tokenuri/i;
const CONTRACT_KEYWORDS = /contract|address|0x[a-f]{2}|deployed|verified|abi/i;

// Chain detection patterns
const CHAIN_PATTERNS: Array<{ pattern: RegExp; chain: string }> = [
  { pattern: /chainId['":\s]*['"]?0?1['"]?|ethereum|mainnet|eth_mainnet/i, chain: 'ethereum' },
  { pattern: /chainId['":\s]*['"]?0?89['"]?|137|polygon|matic/i, chain: 'polygon' },
  { pattern: /chainId['":\s]*['"]?0xa4b1['"]?|42161|arbitrum/i, chain: 'arbitrum' },
  { pattern: /chainId['":\s]*['"]?0xa['"]?|10|optimism/i, chain: 'optimism' },
  { pattern: /chainId['":\s]*['"]?0x2105['"]?|8453|base/i, chain: 'base' },
  { pattern: /chainId['":\s]*['"]?0x4e2a['"]?|7777777|zora/i, chain: 'zora' },
  { pattern: /chainId['":\s]*['"]?0xfdeb['"]?|81457|blast/i, chain: 'blast' },
];

/**
 * Scrape contract addresses from a website
 * First tries server-side fetch, then generates browser scripts if needed
 */
export async function scrapeContractFromWebsite(url: string): Promise<ScrapeResult> {
  const result: ScrapeResult = {
    url,
    contractAddresses: [],
    chain: null,
    method: 'server_fetch',
    browserScript: null,
    confidence: 'low',
    notes: [],
  };

  try {
    // --- Server-side fetch ---
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (status) => status < 400,
    });

    const html: string = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

    // Extract all Ethereum addresses
    const addressRegex = new RegExp(CONTRACT_ADDRESS_PATTERN, 'gi');
    const allMatches = html.match(addressRegex) || [];
    const uniqueAddresses = [...new Set(allMatches.map(a => a.toLowerCase()))];

    // Analyze each address with context
    for (const addr of uniqueAddresses) {
      if (EXCLUDED_LOWERCASE.has(addr)) continue;

      // Find context around the address in HTML
      const lowerHtml = html.toLowerCase();
      let bestContext = '';
      let bestSource = 'html';
      let isLikelyNFT = false;

      // Search in the full HTML for context
      let searchIdx = 0;
      while (searchIdx < html.length) {
        const foundAt = lowerHtml.indexOf(addr, searchIdx);
        if (foundAt === -1) break;

        const contextStart = Math.max(0, foundAt - 150);
        const contextEnd = Math.min(html.length, foundAt + 150);
        const context = html.slice(contextStart, contextEnd).replace(/\s+/g, ' ').trim();

        if (context.length > bestContext.length) {
          bestContext = context;
        }

        // Check NFT context
        if (NFT_KEYWORDS.test(context)) {
          isLikelyNFT = true;
          bestSource = 'nft_context';
        } else if (CONTRACT_KEYWORDS.test(context)) {
          bestSource = 'contract_context';
          isLikelyNFT = true;
        }

        searchIdx = foundAt + 42;
      }

      // Also check meta tags
      const metaMatch = html.match(/<meta[^>]*(?:contract|nft|collection|token)[^>]*0x[a-fA-F0-9]{40}[^>]*>/i);
      if (metaMatch && metaMatch[0].toLowerCase().includes(addr)) {
        bestSource = 'meta_tag';
        isLikelyNFT = true;
      }

      // Check script/config objects
      const scriptMatch = html.match(/<(?:script|script[^>]*type=["']application\/json["'][^>]*)>[^<]*0x[a-fA-F0-9]{40}[^<]*<\/script>/gi);
      if (scriptMatch) {
        for (const sm of scriptMatch) {
          if (sm.toLowerCase().includes(addr)) {
            bestSource = 'script_config';
            if (NFT_KEYWORDS.test(sm) || CONTRACT_KEYWORDS.test(sm)) {
              isLikelyNFT = true;
            }
          }
        }
      }

      result.contractAddresses.push({
        address: addr,
        context: bestContext.slice(0, 300),
        source: bestSource,
        isLikelyNFT,
      });
    }

    // Sort: likely NFT first
    result.contractAddresses.sort((a, b) => {
      if (a.isLikelyNFT && !b.isLikelyNFT) return -1;
      if (!a.isLikelyNFT && b.isLikelyNFT) return 1;
      return 0;
    });

    // Detect chain
    for (const cp of CHAIN_PATTERNS) {
      if (cp.pattern.test(html)) {
        result.chain = cp.chain;
        break;
      }
    }

    // Check if SPA that might need browser
    const isSPA = /__NEXT_DATA__|__NUXT__|react-root|ng-app|vue-app|_app/i.test(html);
    const hasNoAddresses = result.contractAddresses.length === 0;
    const isVeryShortHTML = html.length < 3000 && hasNoAddresses;

    if ((isSPA && hasNoAddresses) || isVeryShortHTML) {
      result.method = 'browser_needed';
      result.browserScript = generateBrowserScrapeScript(url);
      result.notes.push(
        'Website ini SPA (React/Next.js/Vue). Konten dimuat via JavaScript.',
        'Server-side fetch tidak bisa melihat contract address.',
        'Gunakan browser_console() untuk menjalankan script di bawah.',
      );
    }

    // Set confidence
    const nftAddresses = result.contractAddresses.filter(a => a.isLikelyNFT);
    if (nftAddresses.length > 0 && result.chain) {
      result.confidence = 'high';
    } else if (nftAddresses.length > 0 || result.contractAddresses.length > 0) {
      result.confidence = 'medium';
    } else if (hasNoAddresses) {
      result.confidence = 'low';
      result.notes.push('Tidak ada contract address ditemukan via server-side fetch.');
      if (!result.browserScript) {
        result.method = 'browser_needed';
        result.browserScript = generateBrowserScrapeScript(url);
        result.notes.push('Coba gunakan browser script untuk extract dari rendered page.');
      }
    }

    // Limit to top 15 addresses
    if (result.contractAddresses.length > 15) {
      // Keep NFT-likely ones + first few others
      const nftOnes = result.contractAddresses.filter(a => a.isLikelyNFT);
      const others = result.contractAddresses.filter(a => !a.isLikelyNFT).slice(0, 5);
      result.contractAddresses = [...nftOnes, ...others].slice(0, 15);
      result.notes.push(`Ditemukan lebih dari 15 address. Menampilkan top 15 (prioritas NFT context).`);
    }

  } catch (err: any) {
    result.method = 'browser_needed';
    result.browserScript = generateBrowserScrapeScript(url);
    result.notes.push(
      `Server-side fetch gagal: ${err.message?.slice(0, 150)}`,
      'Gunakan browser untuk extract contract address.',
    );
  }

  return result;
}

/**
 * Generate browser console script for scraping contract addresses from rendered page
 * The agent evaluates this via browser_console()
 */
export function generateBrowserScrapeScript(url: string): string {
  return `// === Browser Contract Scraper ===
// Gunakan script ini di browser_console() Hermes setelah navigasi ke website
//
// Langkah:
// 1. browser_navigate(url="${url}")
// 2. Tunggu page load (browser_wait duration=5)
// 3. Jalankan script ini via browser_console(expression="...")

(async () => {
  const results = {
    url: window.location.href,
    contractAddresses: [],
    chain: null,
    windowVars: {},
    iframeAddresses: [],
    networkHints: [],
  };

  // 1. Search rendered HTML
  const html = document.documentElement.innerHTML;
  const addrRegex = /0x[a-fA-F0-9]{40}/gi;
  const allAddr = html.match(addrRegex) || [];
  const unique = [...new Set(allAddr.map(a => a.toLowerCase()))];

  // Filter out known non-NFT addresses
  const excluded = new Set([
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dEaD',
    '0x00005ea67ac36d4aa7f7be4d33385971bae75dee',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    '0x00000000006c3852cbef3e08e8df289169ede581',
  ]);

  const filtered = unique.filter(a => !excluded.has(a));

  // Analyze context
  for (const addr of filtered) {
    const idx = html.toLowerCase().indexOf(addr);
    const ctx = html.slice(Math.max(0, idx - 100), idx + 100).replace(/\\s+/g, ' ');
    const isNFT = /nft|mint|collection|token|supply|claim|drop|contract/i.test(ctx);
    results.contractAddresses.push({ address: addr, isLikelyNFT: isNFT, context: ctx.slice(0, 200) });
  }

  // Sort: NFT-likely first
  results.contractAddresses.sort((a, b) => (b.isLikelyNFT ? 1 : 0) - (a.isLikelyNFT ? 1 : 0));

  // 2. Check window variables
  for (const key of Object.keys(window)) {
    try {
      const val = window[key];
      if (val && typeof val === 'object') {
        const str = JSON.stringify(val);
        if (str && /0x[a-fA-F0-9]{40}/i.test(str)) {
          const found = str.match(/0x[a-fA-F0-9]{40}/gi) || [];
          results.windowVars[key] = found;
        }
      }
    } catch(e) {}
  }

  // 3. Check __NEXT_DATA__ (Next.js)
  if (window.__NEXT_DATA__) {
    try {
      const nextStr = JSON.stringify(window.__NEXT_DATA__);
      const nextAddr = nextStr.match(/0x[a-fA-F0-9]{40}/gi) || [];
      nextAddr.forEach(a => {
        if (!results.contractAddresses.find(c => c.address === a.toLowerCase())) {
          results.contractAddresses.push({ address: a.toLowerCase(), isLikelyNFT: true, context: '__NEXT_DATA__' });
        }
      });
    } catch(e) {}
  }

  // 4. Check for ethereum provider chain
  if (window.ethereum && window.ethereum.chainId) {
    const chainIdMap = { '0x1': 'ethereum', '0x89': 'polygon', '0xa4b1': 'arbitrum', '0xa': 'optimism', '0x2105': 'base' };
    results.chain = chainIdMap[window.ethereum.chainId] || \`chainId:\${window.ethereum.chainId}\`;
  }

  // 5. Network request hints
  if (performance.getEntriesByType) {
    const entries = performance.getEntriesByType('resource');
    results.networkHints = entries
      .map(e => e.name)
      .filter(n => /api|graphql|contract|mint|nft|seadrop|opensea/i.test(n))
      .slice(0, 10);
  }

  // 6. Check data attributes on buttons/links
  const mintElements = document.querySelectorAll('[data-contract], [data-address], [data-token-address], [data-nft]');
  mintElements.forEach(el => {
    const attrs = ['data-contract', 'data-address', 'data-token-address', 'data-nft'];
    attrs.forEach(attr => {
      const val = el.getAttribute(attr);
      if (val && /0x[a-fA-F0-9]{40}/i.test(val)) {
        const found = val.match(/0x[a-fA-F0-9]{40}/gi) || [];
        found.forEach(a => {
          if (!results.contractAddresses.find(c => c.address === a.toLowerCase())) {
            results.contractAddresses.push({ address: a.toLowerCase(), isLikelyNFT: true, context: \`attr:\${attr}\` });
          }
        });
      }
    });
  });

  // Deduplicate final
  const seen = new Set();
  results.contractAddresses = results.contractAddresses.filter(c => {
    if (seen.has(c.address)) return false;
    seen.add(c.address);
    return true;
  });

  return JSON.stringify(results, null, 2);
})()`;
}

/**
 * Generate a focused script for finding contract address
 * from a specific website's network requests
 */
export function generateNetworkScrapeScript(): string {
  return `// === Network Request Monitor for Contract Address ===
// Jalankan SEBELUM navigasi ke website untuk intercept network requests
//
// Langkah:
// 1. Buka tab browser baru
// 2. Jalankan script ini via browser_console()
// 3. Navigasi ke website minting
// 4. Tunggu page load
// 5. Baca hasil dari window.__scrapedAddresses

window.__scrapedAddresses = [];
window.__scrapedNetworkLogs = [];

// Override fetch
const origFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await origFetch.apply(this, args);
  try {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    window.__scrapedNetworkLogs.push({ type: 'fetch', url: url.slice(0, 200) });

    // Clone and read body for API responses
    if (/api|graphql|mint|nft|contract|collection/i.test(url)) {
      const clone = response.clone();
      try {
        const text = await clone.text();
        const addrMatches = text.match(/0x[a-fA-F0-9]{40}/gi) || [];
        addrMatches.forEach(a => {
          if (!window.__scrapedAddresses.find(x => x.address === a.toLowerCase())) {
            window.__scrapedAddresses.push({ address: a.toLowerCase(), source: 'fetch', url: url.slice(0, 100) });
          }
        });
      } catch(e) {}
    }
  } catch(e) {}
  return response;
};

// Override XMLHttpRequest
const origXHR = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  window.__scrapedNetworkLogs.push({ type: 'xhr', method, url: (url || '').slice(0, 200) });
  return origXHR.apply(this, [method, url, ...rest]);
};

console.log('[Scraper] Network monitor aktif! Navigasi ke website minting sekarang.');
console.log('[Scraper] Setelah load, cek: window.__scrapedAddresses');

// Return initial confirmation
return 'Network monitor active. Navigate to the mint website now. Check window.__scrapedAddresses after page loads.';`;
}

/**
 * Script to read scraped results after monitoring
 */
export function generateReadResultsScript(): string {
  return `// === Read Scraped Results ===
// Jalankan setelah website load dan network monitor aktif

JSON.stringify({
  addresses: window.__scrapedAddresses || [],
  networkLogs: (window.__scrapedNetworkLogs || []).slice(-20),
  pageAddresses: (() => {
    const html = document.documentElement.innerHTML;
    const matches = html.match(/0x[a-fA-F0-9]{40}/gi) || [];
    return [...new Set(matches.map(a => a.toLowerCase()))].slice(0, 20);
  })(),
}, null, 2)`;
}
