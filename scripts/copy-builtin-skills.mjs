import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const src = join(root, 'src', 'skills', 'builtin');
const dest = join(root, 'dist', 'skills', 'builtin');

if (!existsSync(src)) {
  console.log('No built-in skills directory found, skipping copy.');
  process.exit(0);
}

mkdirSync(dest, { recursive: true });

const entries = readdirSync(src, { withFileTypes: true });
let count = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const skillDir = join(src, entry.name);
  const skillFile = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) continue;

  mkdirSync(join(dest, entry.name), { recursive: true });
  cpSync(skillFile, join(dest, entry.name, 'SKILL.md'));
  count++;
}

console.log(`Copied ${count} built-in skill(s) to dist/skills/builtin/`);
