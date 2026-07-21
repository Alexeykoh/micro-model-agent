import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ─── Копирование builtin skills ────────────────────────
const skillsSrc = join(root, 'src', 'skills', 'builtin');
const skillsDest = join(root, 'dist', 'skills', 'builtin');

if (existsSync(skillsSrc)) {
  mkdirSync(skillsDest, { recursive: true });
  const entries = readdirSync(skillsSrc, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsSrc, entry.name);
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    mkdirSync(join(skillsDest, entry.name), { recursive: true });
    cpSync(skillFile, join(skillsDest, entry.name, 'SKILL.md'));
    count++;
  }
  console.log(`Copied ${count} built-in skill(s) to dist/skills/builtin/`);
} else {
  console.log('No built-in skills directory found, skipping.');
}

// ─── Копирование builtin plugins ───────────────────────
const pluginsSrc = join(root, 'src', 'plugins', 'builtin');
const pluginsDest = join(root, 'dist', 'plugins', 'builtin');

if (existsSync(pluginsSrc)) {
  mkdirSync(pluginsDest, { recursive: true });
  const entries = readdirSync(pluginsSrc, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = join(pluginsSrc, entry.name);
    const manifestFile = join(pluginDir, 'manifest.json');
    if (!existsSync(manifestFile)) continue;
    mkdirSync(join(pluginsDest, entry.name), { recursive: true });
    // Копируем все файлы плагина (manifest.json + entry point)
    const pluginFiles = readdirSync(pluginDir, { withFileTypes: true });
    for (const file of pluginFiles) {
      if (file.isFile()) {
        cpSync(join(pluginDir, file.name), join(pluginsDest, entry.name, file.name));
      }
    }
    count++;
  }
  console.log(`Copied ${count} built-in plugin(s) to dist/plugins/builtin/`);
} else {
  console.log('No built-in plugins directory found, skipping.');
}