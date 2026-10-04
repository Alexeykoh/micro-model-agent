import { cp, mkdir, rm } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "modules", "skills", "builtin");
const dest = join(root, "dist", "skills", "builtin");

await rm(dest, { recursive: true, force: true });
await mkdir(dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });

// i18n dictionaries — shipped so the compiled JS (which imports the JSON) can
// resolve them from the package even if the bundle was built without inlining.
const i18nDir = join(root, "dist", "i18n");
await mkdir(i18nDir, { recursive: true });
await cp(join(root, "src", "i18n", "en.json"), join(i18nDir, "en.json"));
await cp(join(root, "src", "i18n", "ru.json"), join(i18nDir, "ru.json"));

// `mma web` browser assets are transpiled into `dist/assets` by
// `scripts/build-frontend.ts` (run as part of `build:prod`) — not copied here.

const bridgeSrc = join(root, "src", "modules", "browser", "bridge-server.mjs");
const bridgeDest = join(root, "dist", "modules", "browser");
await mkdir(bridgeDest, { recursive: true });
await cp(bridgeSrc, join(bridgeDest, "bridge-server.mjs"));

// Shipped certification manifest — synced into ~/.mma/certifications.json on
// startup so certified-model marks arrive with package updates.
const certDir = join(root, "dist", "certification");
const certSrc = join(root, "certification", "certifications.json");
try {
  await mkdir(certDir, { recursive: true });
  await cp(certSrc, join(certDir, "certifications.json"));
} catch {
  // No manifest in the repo yet — skip silently.
}
