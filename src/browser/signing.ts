/**
 * Signing Proxy lifecycle helpers for the tools layer.
 *
 * startSigningProxy() spawns the standalone signing server (dist/browser/
 * proxy-server.js) as a detached background process — it survives the tool
 * call — plus (optionally) a cloudflared quick tunnel so the REMOTE Browser
 * Use cloud browser can reach it (its page JS cannot see 127.0.0.1).
 *
 * State is persisted to data/signing_proxy.json (git-ignored):
 *   { pid, port, token, wsUrl, publicUrl?, cloudflaredPid?, startedAt }
 *
 * Security: the token gates every connection; the server re-validates every
 * signing request (selectors, value cap, contract allowlist, chainId).
 * Always stopSigningProxy() after the mint to revoke the token.
 */
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Config, CHAIN_IDS } from '../config';

const STATE_FILE = path.join(process.cwd(), 'data', 'signing_proxy.json');
const LOG_FILE = path.join(process.cwd(), 'data', 'signing_proxy.log');
const TUNNEL_LOG = path.join(process.cwd(), 'data', 'signing_proxy_tunnel.log');

export interface SigningProxyState {
  pid: number;
  port: number;
  token: string;
  wsUrl: string;          // ws://127.0.0.1:PORT
  publicUrl: string | null; // wss://xxx.trycloudflare.com (if tunnel up)
  cloudflaredPid: number | null;
  startedAt: number;
  chain: string;
}

function readState(): SigningProxyState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch { return null; }
}

function writeState(s: SigningProxyState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Is a proxy currently running (process alive)? */
export function getSigningProxyStatus(): { running: boolean; state: SigningProxyState | null } {
  const s = readState();
  if (!s) return { running: false, state: null };
  // Check both the server and tunnel processes.
  const serverAlive = isAlive(s.pid);
  const tunnelAlive = s.cloudflaredPid ? isAlive(s.cloudflaredPid) : false;
  return { running: serverAlive, state: s };
}

async function waitForReady(port: number, timeoutMs = 10000): Promise<boolean> {
  const { WebSocket } = await import('ws');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    const ok = await new Promise<boolean>(resolve => {
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 1500);
        ws.on('open', () => { clearTimeout(t); try { ws.close(); } catch {} resolve(true); });
        ws.on('error', () => { clearTimeout(t); resolve(false); });
      } catch { resolve(false); }
    });
    if (ok) return true;
  }
  return false;
}

async function startTunnel(port: number, token: string): Promise<{ url: string; pid: number } | null> {
  const cloudflared = process.env.CLOUDFLARED_BIN || 'cloudflared';
  try {
    // Only read log lines produced AFTER this run starts (log is append-mode across runs).
    let baseLen = 0;
    try { baseLen = fs.statSync(TUNNEL_LOG).size; } catch {}
    const logFd = fs.openSync(TUNNEL_LOG, 'a');
    const child = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--loglevel', 'info'], {
      detached: true, stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    // Wait for a trycloudflare URL emitted by THIS tunnel instance.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const log = fs.readFileSync(TUNNEL_LOG, 'utf-8').slice(baseLen);
        const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) return { url: m[0], pid: child.pid! };
      } catch {}
    }
    try { process.kill(child.pid!, 0); process.kill(child.pid!, 15); } catch {}
    return null;
  } catch (e: any) {
    console.error(`[SigningProxy] tunnel gagal: ${e.message?.slice(0, 120)}`);
    return null;
  }
}

/**
 * Start the signing proxy (+ optional cloudflared tunnel for Browser Use cloud).
 * Returns the proxy state or throws. Idempotent-ish: if already running,
 * returns the existing state (unless restart=true).
 */
export async function startSigningProxy(opts: {
  publish?: boolean;
  port?: number;
  allowedContracts?: string[];
  maxTxValueEth?: number;
  allowOrderSigning?: boolean;
  restart?: boolean;
}): Promise<SigningProxyState> {
  const existing = readState();
  if (existing && isAlive(existing.pid) && !opts.restart) {
    // Update optional security params if given (server not restarted — warn).
    return { ...existing, chain: existing.chain || '' };
  }

  const config: Config = (await import('../config')).loadConfig();
  const port = opts.port || 18545;
  const token = randomBytes(24).toString('hex');
  const chain = config.chain || 'ethereum';

  const serverEnv: Record<string, string> = {
    PORT: String(port),
    TOKEN: token,
    RPC_URL: config.rpcUrl,
    CHAIN: chain,
    WALLET_PRIVATE_KEYS: config.walletPrivateKeys.join(','),
    MAX_TX_VALUE_ETH: String(opts.maxTxValueEth ?? config.maxMintPriceEth ?? 0.5),
    ALLOWED_CONTRACTS: (opts.allowedContracts || []).join(','),
    ALLOW_SIGNING: opts.allowOrderSigning ? 'true' : 'false',
    MAX_GAS_PRICE_GWEI: String(config.maxGasPriceGwei),
    GAS_MODE: config.gasMode || 'aggressive',
    CUSTOM_PRIORITY_GWEI: process.env.CUSTOM_PRIORITY_GWEI || '',
    CUSTOM_GAS_MULTIPLIER: String(config.customGasMultiplier ?? 1),
    PATH: process.env.PATH || '',
  };

  const logFd = fs.openSync(LOG_FILE, 'a');
  fs.appendFileSync(LOG_FILE, `\n--- signing proxy start ${new Date().toISOString()} ---\n`);
  const child = spawn('node', [path.join(process.cwd(), 'dist', 'browser', 'proxy-server.js')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: serverEnv,
    cwd: process.cwd(),
  });
  child.unref();

  const ready = await waitForReady(port, 12000);
  if (!ready) {
    try { process.kill(child.pid!, 15); } catch {}
    throw new Error('Signing proxy gagal start dalam 12s (cek data/signing_proxy.log).');
  }

  const state: SigningProxyState = {
    pid: child.pid!,
    port,
    token,
    wsUrl: `ws://127.0.0.1:${port}`,
    publicUrl: null,
    cloudflaredPid: null,
    startedAt: Date.now(),
    chain,
  };

  if (opts.publish) {
    const tunnel = await startTunnel(port, token);
    if (tunnel) {
      state.publicUrl = tunnel.url;
      state.cloudflaredPid = tunnel.pid;
    } else {
      console.error('[SigningProxy] cloudflared tidak menghasilkan URL — fallback ke ws://127.0.0.1 (hanya browser lokal).');
    }
  }

  writeState(state);
  return state;
}

/** Stop the signing proxy: kill server + tunnel, remove state (token revoked). */
export function stopSigningProxy(): { stopped: boolean; hadState: boolean } {
  const s = readState();
  if (!s) return { stopped: false, hadState: false };
  let stopped = false;
  if (s.cloudflaredPid) { try { process.kill(s.cloudflaredPid, 15); } catch {} }
  if (s.pid) { try { process.kill(s.pid, 15); } catch {} }
  try { fs.unlinkSync(STATE_FILE); } catch {}
  stopped = true;
  return { stopped, hadState: true };
}

export const SIGNING_PROXY_STATE_FILE = STATE_FILE;
export { CHAIN_IDS };