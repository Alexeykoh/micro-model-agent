/**
 * Собирает `release/latest.json` из фрагментов `release/<key>.json`,
 * которые пишет stage-release.ts на каждой платформе. Запускается финальным
 * job'ом релизного workflow (после скачивания всех фрагментов).
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReleaseArtifact, ReleasePlatformKey } from "../src/modules/updater/release.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "release");

interface Fragment extends ReleaseArtifact {
  key: ReleasePlatformKey;
  version: string;
}

async function main(): Promise<void> {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const { artifacts, version } = await loadFragments();
  if (Object.keys(artifacts).length === 0) {
    throw new Error("no release fragments found in release/*.json");
  }

  const manifest = {
    version: version ?? pkg.version,
    releasedAt: new Date().toISOString(),
    artifacts,
  };
  await writeFile(join(outDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `[manifest] latest.json v${manifest.version} — ${Object.keys(artifacts).join(", ")}\n`,
  );
}

/** Читает все фрагменты (кроме latest.json) и сливает в карту артефактов. */
async function loadFragments(): Promise<{
  artifacts: Partial<Record<ReleasePlatformKey, ReleaseArtifact>>;
  version: string | null;
}> {
  const files = (await readdir(outDir)).filter(
    (f) => f.endsWith(".json") && f !== "latest.json",
  );
  const artifacts: Partial<Record<ReleasePlatformKey, ReleaseArtifact>> = {};
  let version: string | null = null;
  for (const f of files) {
    const frag = JSON.parse(await readFile(join(outDir, f), "utf8")) as Fragment;
    const artifact = toArtifact(frag);
    if (!artifact) continue;
    artifacts[frag.key] = artifact;
    version = frag.version ?? version;
  }
  return { artifacts, version };
}

/** Превращает фрагмент в артефакт, либо null для неполной записи. */
function toArtifact(frag: Fragment): ReleaseArtifact | null {
  if (!frag.key || !frag.sha256) return null;
  return { url: frag.url, sha256: frag.sha256, size: frag.size };
}

await main();
