import { cp, mkdir, rm } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "modules", "skills", "builtin");
const dest = join(root, "dist", "skills", "builtin");

await rm(dest, { recursive: true, force: true });
await mkdir(dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });

const bridgeSrc = join(root, "src", "modules", "browser", "bridge-server.mjs");
const bridgeDest = join(root, "dist", "modules", "browser");
await mkdir(bridgeDest, { recursive: true });
await cp(bridgeSrc, join(bridgeDest, "bridge-server.mjs"));
