#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// MMA is designed to run under Bun: clipboard image paste relies on
// `Bun.Image.fromClipboard()` (Node has no clipboard API), and on Windows a
// bare `npx.cmd` shim can only be spawned reliably through Bun's child_process
// (under Node it throws `spawn EINVAL`). The global npm shim (`mma` /
// `mma.cmd`) launches this file under Node, so re-execute ourselves under Bun
// when it is available. The `bun run mma` path already runs under Bun and
// skips the respawn.
const runningUnderBun =
	typeof globalThis.Bun !== "undefined" &&
	typeof globalThis.Bun?.version !== "undefined";

if (process.env.MMA_DEBUG_RUNTIME) {
	console.error(
		"[mma] runtime=" +
			(runningUnderBun ? `bun ${globalThis.Bun.version}` : `node ${process.version}`),
	);
}

if (!runningUnderBun) {
	try {
		const res = spawnSync("bun", [process.argv[1], ...process.argv.slice(2)], {
			stdio: "inherit",
			windowsHide: true,
		});
		if (res.error) throw res.error;
		process.exit(res.status ?? 0);
	} catch {
		// `bun` is not on PATH — fall back to the Node import path (clipboard
		// paste and LSP will degrade, but the agent still works).
	}
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const main = join(__dirname, "..", "dist", "main.js");

await import(pathToFileURL(main).href);
