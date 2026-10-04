// Cross-platform `dist` removal (replaces the Windows-only `cmd /c rmdir`).
import { rm } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await rm(join(root, "dist"), { recursive: true, force: true });
