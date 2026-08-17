#!/usr/bin/env node
/**
 * Hermes MCP launcher for nft-mint-agent.
 *
 * Loads .env from THIS directory into the process environment, then starts the
 * real MCP server (mcp-server.mjs). This keeps all secrets (RPC keys, wallet
 * private keys) OUT of Hermes config.yaml — they stay in the repo's .env file.
 *
 * Hermes config:  hermes mcp add nft_mint --command node --args /root/nft-mint-agent/mcp-hermes.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = join(__dirname, '.env');

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Do not override variables already set in the environment (e.g. injected by Hermes).
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

await import(join(__dirname, 'mcp-server.mjs'));
