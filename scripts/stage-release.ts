/**
 * Собирает самодостаточный релизный tarball одной платформы.
 *
 * Раскладка внутри архива:
 *   runtime/bun(.exe)   — рантайм Bun этой платформы
 *   app/main.js         — собранный CLI (dist/main.js)
 *   app/assets/**       — веб-ассеты (готовые)
 *   app/modules/**      — browser bridge-server.mjs (читается с диска)
 *   app/skills/builtin/** — встроенные скиллы (читаются с диска)
 *   app/certification/**  — bundle-манифест сертификаций (читается с диска)
 *   app/node_modules/** — prod-зависимости (external в бандле)
 *   package.json        — имя+версия (для readMmaVersion/readChangelog)
 *   CHANGELOG.md
 *   VERSION
 *
 * Результат: `release/mma-<key>.tar.gz` и фрагмент `release/<key>.json`
 * (sha256/size/url). Финальный `latest.json` собирает build-manifest.ts.
 *
 * Env: RELEASE_KEY (иначе определяется по ОС/arch), RELEASE_SKIP_NODE_MODULES=1
 * (проверка структуры без тяжёлой копии), RELEASE_NODE_MODULES (кастомный путь),
 * RELEASE_SKIP_RUNTIME=1 (пропустить копию bun — для тестов структуры).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactName,
  releasePlatformKey,
  type ReleasePlatformKey,
} from "../src/modules/updater/release.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "release");

/**
 * Каталоги `dist/`, которые рантайм читает С ДИСКА (не инлайнятся бандлом) и
 * поэтому обязаны попасть в релиз. `copy-assets.ts` кладёт их в `dist/`;
 * раскладка внутри архива — `app/<dir>/**`, что совпадает с резолвом рядом с
 * `main.js` (`import.meta.dirname`).
 *
 * - `modules/browser/bridge-server.mjs` — тул `browser` (иначе `Cannot find module`).
 * - `skills/builtin/**` — встроенные скиллы (`load_skill`).
 * - `certification/certifications.json` — bundle-манифест (синк в `~/.mma`).
 */
export const RUNTIME_APP_DIRS = ["modules", "skills", "certification"] as const;

async function main(): Promise<void> {
  const key = resolveKey();
  const version = await readVersion();
  const stage = join(outDir, `.stage-${key}`);

  await rm(stage, { recursive: true, force: true });
  await buildStage(stage, version);
  const name = artifactName(key);
  const tarball = await pack(stage, name);
  await rm(stage, { recursive: true, force: true });

  const sha256 = await sha256File(tarball);
  const size = (await stat(tarball)).size;
  await writeFile(
    join(outDir, `${key}.json`),
    `${JSON.stringify({ key, version, sha256, size, url: name }, null, 2)}\n`,
  );
  process.stdout.write(
    `[release] ${name}  ${(size / 1e6).toFixed(1)} MB  sha256=${sha256}\n`,
  );
}

function resolveKey(): ReleasePlatformKey {
  const key =
    (process.env.RELEASE_KEY as ReleasePlatformKey | undefined) ??
    releasePlatformKey(process.platform, process.arch);
  if (!key) {
    throw new Error(`unsupported target ${process.platform}/${process.arch}; set RELEASE_KEY`);
  }
  return key;
}

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  return pkg.version as string;
}

/** Складывает рантайм, приложение и метаданные в staging-каталог. */
export async function buildStage(
  stage: string,
  version: string,
  opts: { distDir?: string } = {},
): Promise<void> {
  const distDir = opts.distDir ?? join(root, "dist");
  await mkdir(join(stage, "app"), { recursive: true });
  await mkdir(join(stage, "runtime"), { recursive: true });
  await cp(join(distDir, "main.js"), join(stage, "app", "main.js"));
  await cp(join(distDir, "assets"), join(stage, "app", "assets"), { recursive: true });

  // Runtime-read dirs (browser bridge, builtin skills, cert manifest). Missing
  // dirs are skipped: `certification/` is optional when no manifest exists yet.
  for (const dir of RUNTIME_APP_DIRS) {
    const src = join(distDir, dir);
    if (await exists(src)) await cp(src, join(stage, "app", dir), { recursive: true });
  }

  if (process.env.RELEASE_SKIP_RUNTIME !== "1") {
    const bunName = process.platform === "win32" ? "bun.exe" : "bun";
    await cp(process.execPath, join(stage, "runtime", bunName));
  }

  await copyNodeModules(stage);
  await writeMeta(stage, version);
}

/** Копирует prod-зависимости (пропускается для быстрой проверки структуры). */
async function copyNodeModules(stage: string): Promise<void> {
  if (process.env.RELEASE_SKIP_NODE_MODULES === "1") return;
  const nm = process.env.RELEASE_NODE_MODULES ?? join(root, "node_modules");
  await cp(nm, join(stage, "app", "node_modules"), { recursive: true });
}

/** Пишет package.json (имя/версия), VERSION и CHANGELOG рядом с приложением. */
async function writeMeta(stage: string, version: string): Promise<void> {
  await writeFile(
    join(stage, "package.json"),
    `${JSON.stringify({ name: "micro-models-agent", version, type: "module" }, null, 2)}\n`,
  );
  await writeFile(join(stage, "VERSION"), `${version}\n`);
  const changelog = join(root, "CHANGELOG.md");
  if (await exists(changelog)) await cp(changelog, join(stage, "CHANGELOG.md"));
}

/** Пакует staging в `release/<name>` и возвращает путь к архиву. */
async function pack(stage: string, name: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const tarball = join(outDir, name);
  await rm(tarball, { force: true });
  runTar(tarball, stage);
  return tarball;
}

function runTar(tarball: string, stage: string): void {
  const res = spawnSync("tar", ["-czf", tarball, "-C", stage, "."], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (res.error || res.status !== 0) throw new Error(tarFailure(res));
}

function tarFailure(res: { error?: Error; status: number | null }): string {
  return res.error ? `tar failed: ${res.error.message}` : `tar failed: exit ${res.status}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (c) => hash.update(c))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) await main();
