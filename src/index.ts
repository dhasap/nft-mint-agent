import { SKILL_DEFINITION, TOOLS } from './tools';

/**
 * Auto Mint Agent - Hermes Skill Entry Point
 *
 * Skill ini menyediakan tools untuk auto-minting NFT
 * yang bisa dipanggil oleh Hermes agent.
 *
 * Usage from Hermes agent:
 *   const mintSkill = require('auto-mint-agent');
 *   const result = await mintSkill.TOOLS.parse_mint_link({ url: '...' });
 */

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   🤖 Auto Mint Agent - Hermes Skill v2.0    ║');
  console.log('║   Multi-Wallet Minting + Interactive Listing ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  console.log('Available Tools:');
  for (const tool of SKILL_DEFINITION.tools) {
    console.log(`  🔧 ${tool.name} - ${tool.description.slice(0, 60)}...`);
  }
  console.log('\n💡 This skill is designed to be used by Hermes agent.');
  console.log('   Import and call TOOLS.<tool_name>(params) to use.');
}

// Run main only when executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { SKILL_DEFINITION, TOOLS };
