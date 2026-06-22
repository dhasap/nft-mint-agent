#!/usr/bin/env node
/**
 * CLI runner for nft-mint-agent tools.
 * Usage: node runner.mjs <tool_name> '<json_params>'
 *
 * Validates arguments against each tool's JSON Schema (from SKILL_DEFINITION)
 * BEFORE execution, and prints self-correcting errors so an agent can fix its
 * call instead of failing silently.
 */
import { TOOLS, SKILL_DEFINITION } from './dist/tools/index.js';

const [, , toolName, paramsJson] = process.argv;
const names = Object.keys(TOOLS);

function printUsage(stream = console.log) {
  stream("Usage: node runner.mjs <tool_name> '<json_params>'");
  stream('Tools:\n  ' + names.join('\n  '));
  stream("\nExample:\n  node runner.mjs detect_contract '{\"contract_address\":\"0x...\"}'");
}

if (!toolName || toolName === '--help' || toolName === '-h') {
  printUsage();
  process.exit(toolName ? 0 : 1);
}

if (!TOOLS[toolName]) {
  console.error(`❌ Unknown tool: ${toolName}`);
  const sugg = names.filter((n) => n.includes(toolName) || toolName.includes(n));
  if (sugg.length) console.error(`   Did you mean: ${sugg.join(', ')}?`);
  console.error(`   Available: ${names.join(', ')}`);
  process.exit(1);
}

// Parse JSON params with a clear error if malformed.
let params = {};
if (paramsJson && paramsJson !== '{}') {
  try {
    params = JSON.parse(paramsJson);
  } catch (e) {
    console.error(JSON.stringify({
      success: false,
      error: `Invalid JSON params: ${e.message}`,
      hint: "Wrap params in single quotes and use double quotes for JSON keys/values.",
      got: paramsJson,
    }, null, 2));
    process.exit(1);
  }
}

// Schema validation against SKILL_DEFINITION.
const def = (SKILL_DEFINITION.tools || []).find((t) => t.name === toolName);
if (def?.parameters) {
  const { properties = {}, required = [] } = def.parameters;
  const errors = [];

  for (const r of required) {
    const v = params[r];
    if (v === undefined || v === null || v === '') errors.push(`missing required param "${r}"`);
  }
  for (const [k, v] of Object.entries(params)) {
    const spec = properties[k];
    if (!spec) {
      errors.push(`unknown param "${k}" (allowed: ${Object.keys(properties).join(', ') || 'none'})`);
      continue;
    }
    if (spec.type === 'number' && typeof v !== 'number') errors.push(`"${k}" must be a number, got ${typeof v}`);
    if (spec.type === 'string' && typeof v !== 'string') errors.push(`"${k}" must be a string, got ${typeof v}`);
    if (spec.type === 'boolean' && typeof v !== 'boolean') errors.push(`"${k}" must be a boolean, got ${typeof v}`);
    if (spec.type === 'array' && !Array.isArray(v)) errors.push(`"${k}" must be an array, got ${typeof v}`);
  }

  if (errors.length) {
    console.error(JSON.stringify({
      success: false,
      error: 'invalid arguments',
      tool: toolName,
      details: errors,
      required,
      schema: def.parameters,
    }, null, 2));
    process.exit(1);
  }
}

try {
  const result = await TOOLS[toolName](params);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
}
