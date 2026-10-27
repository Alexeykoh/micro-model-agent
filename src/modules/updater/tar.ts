// Обёртка над системным `tar`: аргументы без путей с буквой диска.
import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

/**
 * Аргументы и cwd для `tar`: архив передаётся **basename** при `cwd` его
 * каталога. Абсолютный `C:\…` GNU-tar читает как `host:path` и падает с
 * «Cannot connect to C:» — так ломалась распаковка, если первым в PATH стоит
 * GNU tar (Git for Windows), а не bsdtar из System32.
 *
 * @param tarball путь к архиву; @param dest каталог распаковки.
 * @returns argv для листинга, argv для распаковки и cwd.
 */
export function tarPlan(
  tarball: string,
  dest: string,
): { cwd: string; list: string[]; extract: string[] } {
  const cwd = dirname(resolve(tarball));
  const name = basename(tarball);
  const extract = ["-xzf", name, "-C", resolve(dest)];
  // GNU/busybox понимают флаг, bsdtar на Windows — нет; владелец там не при чём.
  if (process.platform !== "win32") extract.push("--no-same-owner");
  return { cwd, list: ["-tzvf", name], extract };
}

/** Запускает `tar` и возвращает stdout (stderr — в текст ошибки). */
export function execTar(args: string[], cwd?: string): Promise<string> {
  const execOpts = { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(cwd ? { cwd } : {}) };
  return new Promise((resolveOut, reject) => {
    execFile("tar", args, execOpts, (err, stdout, stderr) =>
      err ? reject(new Error(`tar failed: ${stderr || err.message}`)) : resolveOut(stdout),
    );
  });
}
