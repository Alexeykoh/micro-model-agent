// Профиль пользователя: сбор фактов окружения, персист в profile.json, преференсы.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, hostname, platform, type, } from "os";
import { env } from "process";
import { ProfileCompressor } from "./compressor";

/** Снимок окружения пользователя: платформа, шелл, дом, версии, преференсы. */
export interface ProfileInfo {
  platform: string;
  os: string;
  hostname: string;
  shell: string;
  home: string;
  nodeVersion: string;
  preferences: Record<string, string>;
}

/** Профиль пользователя с персистом в `<dir>/profile.json`. */
export class UserProfile {
  private profileDir: string;
  private info: ProfileInfo | null = null;
  private preferences: Record<string, string> = {};

  constructor(profileDir: string) {
    this.profileDir = profileDir;
  }

  /** Собирает факты окружения (ОС, шелл, дом, node) в свежий снимок. */
  collect(): ProfileInfo {
    this.info = {
      platform: platform(),
      os: `${type()} ${hostname()}`,
      hostname: hostname(),
      shell: env.SHELL || env.ComSpec || "unknown",
      home: homedir(),
      nodeVersion: process.version,
      preferences: { ...this.preferences },
    };
    return this.info;
  }

  /** Сохраняет текущий снимок и преференсы в profile.json. */
  save(): void {
    if (!existsSync(this.profileDir)) {
      mkdirSync(this.profileDir, { recursive: true });
    }
    writeFileSync(
      join(this.profileDir, "profile.json"),
      JSON.stringify({ ...this.info, preferences: this.preferences }, null, 2),
      "utf-8",
    );
  }

  /** Загружает снимок из profile.json; null, если файла нет или он бит. */
  load(): ProfileInfo | null {
    const path = join(this.profileDir, "profile.json");
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      this.info = {
        platform: data.platform,
        os: data.os,
        hostname: data.hostname,
        shell: data.shell,
        home: data.home,
        nodeVersion: data.nodeVersion,
        preferences: data.preferences || {},
      };
      this.preferences = data.preferences || {};
      return this.info;
    } catch {
      return null;
    }
  }

  /** Последний собранный/загруженный снимок (null до collect/load). */
  getInfo(): ProfileInfo | null {
    return this.info;
  }

  /** Записывает преференс (в файл попадёт при save). */
  setPreference(key: string, value: string): void {
    this.preferences[key] = value;
  }

  /** Читает преференс; undefined, если не задан. */
  getPreference(key: string): string | undefined {
    return this.preferences[key];
  }

  /** Компактная строка профиля для промпта (собирает снимок при нужде). */
  compress(): string {
    if (!this.info) this.collect();
    const compressor = new ProfileCompressor();
    return compressor.compress(this.info!);
  }
}
