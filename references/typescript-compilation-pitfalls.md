# TypeScript Compilation Pitfalls with ethers.js v6

When modifying the NFT minting skill codebase, these compilation issues will bite you.

## 1. BigInt Literals

**Problem:** `0n`, `21000n`, `100n` syntax requires target ES2020+. The tsconfig has `target: "ES2022"` but if you change it or copy code to another project:

```typescript
// BROKEN if target < ES2020:
const value = 0n;
const gasLimit = 21000n;

// SAFE everywhere:
const value = BigInt(0);
const gasLimit = BigInt(21000);
```

**Rule:** Always use `BigInt()` constructor in code that might be shared.

## 2. Set/Map Iteration

**Problem:** `[...new Set(arr)]` and `for (const x of map.values())` require `downlevelIteration: true` or target ES2015+.

```typescript
// BROKEN without downlevelIteration:
const unique = [...new Set(allMatches)];  // scrape.ts:105
for (const job of this.jobs.values()) {}  // scheduler/index.ts:119
```

**Fix in tsconfig.json:**
```json
{
  "compilerOptions": {
    "downlevelIteration": true,
    "target": "ES2022"
  }
}
```

## 3. Default Imports

**Problem:** `import dotenv from 'dotenv'` fails without `allowSyntheticDefaultImports`.

```typescript
// BROKEN:
import dotenv from 'dotenv';

// SAFE:
import * as dotenv from 'dotenv';
```

**Fix:** Either use `import * as` or add to tsconfig:
```json
{
  "compilerOptions": {
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true
  }
}
```

## 4. ethers.js Private Identifiers

**Problem:** ethers.js v6 type definitions use `#private` syntax (private class fields). Under strict checking without `skipLibCheck`, this produces 40+ errors like:
```
error TS18028: Private identifiers are only available when targeting ECMAScript 2015 and higher.
```

**Fix:** Must have `skipLibCheck: true` in tsconfig. This is non-negotiable with ethers.js.

## 5. Known-Good tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "downlevelIteration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

