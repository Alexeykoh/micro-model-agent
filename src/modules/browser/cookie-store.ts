// Персистентное хранилище cookies браузера (cookies.json в cookieDir).
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

/** Кука браузера для сохранения между сессиями. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Файловое хранилище кук (cookies.json). */
export class CookieStore {
  private filePath: string;

  constructor(cookieDir: string) {
    this.filePath = join(cookieDir, "cookies.json");
  }

  /** Сохранить куки в файл. */
  async save(cookies: StoredCookie[]): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(cookies, null, 2), "utf-8");
  }

  /** Загрузить куки; при отсутствии/битом файле — пустой список. */
  async load(): Promise<StoredCookie[]> {
    try {
      const data = await readFile(this.filePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /** Удалить все куки. */
  async clear(): Promise<void> {
    await this.save([]);
  }
}
