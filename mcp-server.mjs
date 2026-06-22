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
 * IMPORTANT — by design the competitive `fast-mint` path is NOT exposed as an
 * MCP tool. Routing each hot mint through the model/transport adds latency and
 * defeats the purpose. For FCFS / max / hot drops, launch the CLI directly:
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

const server = new Server(
  { name: 'nft-mint-agent', version: VERSION },
  { capabilities: { tools: {} } },
);

// Advertise every tool defined in SKILL_DEFINITION, using its JSON Schema.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (SKILL_DEFINITION.tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters ?? { type: 'object', properties: {} },
  })),
}));

// Dispatch a tool call to the corresponding TOOLS handler.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = req.params.arguments ?? {};
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
  console.error(`nft-mint-agent MCP server v${VERSION} running on stdio (${Object.keys(TOOLS).length} tools)`);
}

main().catch((e) => {
  console.error('MCP server fatal error:', e);
  process.exit(1);
});
