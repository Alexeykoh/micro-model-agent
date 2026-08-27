// Test scenario for syntax validation features
// This tests that pre-validation blocks invalid syntax and import conflict detection works

import type { CertScenario } from "./types";

const SYNTAX_VALIDATION_SCENARIOS: CertScenario[] = [
  {
    id: "syntax-01-block-invalid",
    title: "Block writing file with syntax error",
    tags: ["core"],
    mode: "run",
    prompt:
      'Try to create a file bad.ts with this exact content: export function foo() { const x = }. The file should NOT be written because it has a syntax error.',
    checks: [
      { type: "fileNotExists", path: "bad.ts" },
      { type: "outputContains", text: "Syntax error" },
    ],
  },
  {
    id: "syntax-02-write-valid",
    title: "Write valid TypeScript file",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create file good.ts with content: export const x = 1;',
    checks: [
      { type: "fileExists", path: "good.ts" },
      { type: "fileContent", path: "good.ts", contains: "export const x = 1" },
    ],
  },
  {
    id: "syntax-03-import-conflict",
    title: "Detect import conflict warning",
    tags: ["core"],
    mode: "run",
    prompt:
      'Create file conflict.ts with this content:\nimport { foo } from "./helper";\nexport function foo() { return 1; }',
    checks: [
      { type: "fileExists", path: "conflict.ts" },
      { type: "outputContains", text: "Import/export conflicts" },
    ],
  },
  {
    id: "syntax-04-refactor-monolith",
    title: "Refactor monolith into modules",
    tags: ["core"],
    mode: "run",
    prompt:
      "Create a file monolith.ts with this content:\nexport interface Product { id: string; price: number; }\nexport function calculatePrice(items: Product[]): number { return items.reduce((sum, p) => sum + p.price, 0); }\nexport function validateEmail(email: string): boolean { return email.includes('@'); }\n\nThen refactor it into two files: pricing.ts (with Product and calculatePrice) and validation.ts (with validateEmail).",
    checks: [
      { type: "fileExists", path: "pricing.ts" },
      { type: "fileExists", path: "validation.ts" },
      { type: "fileContent", path: "pricing.ts", contains: "calculatePrice" },
      { type: "fileContent", path: "validation.ts", contains: "validateEmail" },
    ],
  },
];

export { SYNTAX_VALIDATION_SCENARIOS };
