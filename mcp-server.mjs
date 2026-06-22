#!/usr/bin/env node
/**
 * nft-mint-agent — Model Context Protocol (MCP) server.
 *
 * Exposes the read / detection / decision / listing tools over MCP with
 * validated JSON Schemas so any MCP host (Claude Desktop, Claude Code,
 * Cursor, custom agents) can call them reliably with typed arguments.
 *
 * Implemented as ESM (.mjs) so it can import the ESM-only MCP SDK while still
 * consuming the project's compiled CommonJS tools from ./dist — run `npm run build` first.
 *
 * Safety:
 *   - Each tool is annotated with readOnlyHint / destructiveHint so hosts can warn
 *     the user before a state-changing call.
 *   - Set MCP_READONLY=true to expose ONLY read-only tools and reject execution
 *     calls — route minting/listing through the CLI when you want a hard boundary.
 *
 * IMPORTANT — by design the competitive `fast-mint` path is NOT exposed as an
 * MCP tool. Routing each hot mint through the model/transport adds latency.
 * For FCFS / max / hot drops, launch the CLI directly:
 *
 *   node fast-mint.mjs --url "<opensea collection>" --time auto --qty max --wallets 0,1 \
 *     --gas-mode aggressive --priority-gwei 8 --max-fee-gwei 150
 *
 * See docs/MCP.md for setup and the full tool/route split.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, SKILL_DEFINITION } from './dist/tools/index.js';

const VERSION = '3.3.0';

// Read-only tools: no signing, no broadcast, no spend, no state change.
const READONLY_TOOLS = new Set([
  'parse_mint_link', 'detect_contract', 'check_wallets', 'get_mint_schedule',
  'get_mint_status', 'scrape_contract_from_website', 'get_skill_health', 'list_scheduled_mints',
]);

// MCP_READONLY=true → only safe tools are listed/callable; execution stays on the CLI.
const READONLY_MODE = ['1', 'true', 'yes'].includes(String(process.env.MCP_READONLY || '').toLowerCase());

function isReadOnly(name) { return READONLY_TOOLS.has(name); }

function annotate(t) {
  const ro = isReadOnly(t.name);
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.parameters ?? { type: 'object', properties: {} },
    annotations: {
      title: t.name,
      readOnlyHint: ro,
      destructiveHint: !ro,        // minting/listing/cancel change state or spend funds
      openWorldHint: true,         // interacts with external chains/APIs
    },
  };
}

const server = new Server(
  { name: 'nft-mint-agent', version: VERSION },
  { capabilities: { tools: {} } },
);

// Advertise tools (filtered in read-only mode), each with safety annotations.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const defs = (SKILL_DEFINITION.tools || []).filter((t) => !READONLY_MODE || isReadOnly(t.name));
  return { tools: defs.map(annotate) };
});

// Dispatch a tool call; refuse execution tools when in read-only mode.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = req.params.arguments ?? {};

  if (READONLY_MODE && !isReadOnly(name)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool "${name}" is disabled in read-only mode (MCP_READONLY=true). Run it via the CLI: node runner.mjs ${name} '<json>'` }],
    };
  }

  const fn = TOOLS[name];
  if (typeof fn !== 'function') {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}. Available: ${Object.keys(TOOLS).join(', ')}` }],
    };
  }

  try {
    const result = await fn(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: err?.message ?? String(err) }) }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs MUST go to stderr — stdout is the MCP transport channel.
  const count = (SKILL_DEFINITION.tools || []).filter((t) => !READONLY_MODE || isReadOnly(t.name)).length;
  console.error(`nft-mint-agent MCP server v${VERSION} on stdio — ${count} tools${READONLY_MODE ? ' (READ-ONLY mode)' : ''}`);
}

main().catch((e) => {
  console.error('MCP server fatal error:', e);
  process.exit(1);
});
