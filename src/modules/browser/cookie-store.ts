import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

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

export class CookieStore {
  private filePath: string;

  constructor(cookieDir: string) {
    this.filePath = join(cookieDir, "cookies.json");
  }

  async save(cookies: StoredCookie[]): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(cookies, null, 2), "utf-8");
  }

  async load(): Promise<StoredCookie[]> {
    try {
      const data = await readFile(this.filePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    await this.save([]);
  }
}
