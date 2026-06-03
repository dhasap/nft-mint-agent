#!/usr/bin/env node
/**
 * CLI runner for Auto Mint Agent tools.
 * Usage: node runner.mjs <tool_name> '<json_params>'
 */
import { TOOLS } from './dist/tools/index.js';

const [,, toolName, paramsJson] = process.argv;

if (!toolName || !TOOLS[toolName]) {
  console.error(`Unknown tool: ${toolName}`);
  console.error(`Available: ${Object.keys(TOOLS).join(', ')}`);
  process.exit(1);
}

const params = paramsJson ? JSON.parse(paramsJson) : {};

try {
  const result = await TOOLS[toolName](params);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
}
