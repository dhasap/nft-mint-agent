#!/usr/bin/env node
/**
 * bridge-client — forward ONE signing/relay request to the local signing proxy.
 *
 * Used for the Browser Use cloud path: the cloud browser cannot reach
 * ws://127.0.0.1, so the injected relay falls back to window.__signQ/__signR
 * queues. The agent pulls each queued request via js(), pipes it through this
 * client (which talks to the LOCAL signing proxy over 127.0.0.1), then writes
 * the result back into the page.
 *
 * Usage (from repo root):
 *   node bridge-client.mjs --req '<json>' [--ws ws://127.0.0.1:18545] [--token <t>]
 *   req shape: { "id": 1, "method": "eth_sendTransaction", "params": [...], "__addr": "0x..." }
 *
 * Output: {"success":true,"result":...} on stdout, or exit 1 with error JSON.
 */
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

const wsUrl = get('--ws') || process.env.SIGNING_PROXY_WS || 'ws://127.0.0.1:18545';
const token = get('--token') || process.env.SIGNING_PROXY_TOKEN || '';
const reqRaw = get('--req');
if (!reqRaw) {
  console.error(JSON.stringify({ success: false, error: 'missing --req <json>' }));
  process.exit(1);
}

let req;
try { req = JSON.parse(reqRaw); } catch (e) {
  console.error(JSON.stringify({ success: false, error: `bad --req json: ${e.message}` }));
  process.exit(1);
}

const ws = new WebSocket(`${wsUrl}?token=${token}`);
const timer = setTimeout(() => {
  console.error(JSON.stringify({ success: false, error: 'bridge-client timeout' }));
  try { ws.close(); } catch {}
  process.exit(1);
}, 25000);

ws.on('open', () => {
  ws.send(JSON.stringify({
    id: req.id || 1,
    method: req.method,
    params: req.params || [],
    __addr: req.__addr,
  }));
});

ws.on('message', (raw) => {
  clearTimeout(timer);
  let j;
  try { j = JSON.parse(String(raw)); } catch {
    console.error(JSON.stringify({ success: false, error: 'bad response from proxy' }));
    process.exit(1);
  }
  if (j.error) {
    console.error(JSON.stringify({ success: false, error: j.error }));
    process.exit(1);
  }
  console.log(JSON.stringify({ success: true, result: j.result }));
  try { ws.close(); } catch {}
  process.exit(0);
});

ws.on('error', (e) => {
  clearTimeout(timer);
  console.error(JSON.stringify({ success: false, error: String(e.message || e) }));
  process.exit(1);
});

ws.on('close', (code, reason) => {
  clearTimeout(timer);
  console.error(JSON.stringify({ success: false, error: `proxy connection closed (${code} ${String(reason).slice(0, 60)})` }));
  process.exit(1);
});
