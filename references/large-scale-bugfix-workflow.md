# Large-Scale Bug Fix & PRD Optimization Workflow

When handed a bug report (25+ bugs) and PRD to implement against an existing codebase.

## Workflow

### Phase 1: Audit (read-only)
1. Read ALL source files to understand the codebase
2. Read the bug report and PRD completely
3. Map each bug to the specific file/line it affects
4. Identify which bugs are already fixed in the current code (many audits are stale)

### Phase 2: Fix by severity
1. **Critical first** — data loss, security, broken core features
2. **High next** — reliability, correctness
3. **Medium** — edge cases, UX improvements
4. **Low** — architecture, naming, docs

### Phase 3: New features
1. Add new tools/modules after bug fixes
2. Keep backward compatibility — don't break existing interfaces
3. Add to SKILL_DEFINITION + TOOLS export

### Phase 4: Build & verify
1. `npm run build` after each batch of changes
2. Verify tool count matches SKILL_DEFINITION
3. Check for TypeScript strict mode issues

### Phase 5: Commit & push
1. Single commit with all changes
2. Detailed commit message listing bug IDs fixed
3. Push to GitHub

## Common Pitfalls

### ⚠️ TypeScript build vs lint checker mismatch
The `patch` tool's built-in lint checker may show errors from ethers.js node_modules that the actual `tsc` build ignores (because `skipLibCheck: true`). Always verify with `npm run build`, not the lint output.

Common false positives from lint checker:
- `TS18028: Private identifiers are only available when targeting ECMAScript 2015` — ethers.js types, skipped by skipLibCheck
- `TS2802: Type 'Set<any>' can only be iterated` — handled by downlevelIteration in tsconfig
- `TS2737: BigInt literals are not available` — handled by target ES2022

**Rule:** If `npm run build` passes, ignore lint checker errors from node_modules.

### ⚠️ BigInt literals in shared code
When code might be copied to other projects, always use `BigInt(0)` not `0n`, `BigInt(21000)` not `21000n`. The literal syntax requires target ES2020+.

### ⚠️ Duplicate code in fallback paths
When implementing fixes (e.g., ERC-1155 token ID extraction), check if the same pattern exists in multiple files (direct.ts AND opensea.ts). Fix both.

### ⚠️ `this` context in standalone functions
When adding new tools to `tools/index.ts`, remember that standalone functions (not class methods) can't use `this`. Use the module-level `config` variable instead of `this.config`.

### ⚠️ SKILL_DEFINITION + TOOLS must stay in sync
Every tool in `TOOLS` export must have a corresponding entry in `SKILL_DEFINITION.tools`. Verify count matches after changes.

## Verification Checklist

```bash
# Build
npm run build

# Verify tool count
node -e "const {TOOLS} = require('./dist/tools'); console.log('Tools:', Object.keys(TOOLS).length);"
node -e "const {SKILL_DEFINITION} = require('./dist/tools'); console.log('Definition:', SKILL_DEFINITION.tools.length);"

# Check git status
git diff --stat HEAD
git status --short
```

