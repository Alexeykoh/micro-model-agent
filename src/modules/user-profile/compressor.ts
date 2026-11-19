// Компрессор профиля: сворачивает ProfileInfo в одну строку для промпта.
import type { ProfileInfo } from "./profile";

/** Сворачивает профиль в компактную строку `OS/Shell/Platform/Prefs`. */
export class ProfileCompressor {
  /** Сжимает инфо профиля в одну строку; пустые преференсы опускаются. */
  compress(info: ProfileInfo): string {
    const parts: string[] = [
      `OS: ${info.os}`,
      `Shell: ${info.shell}`,
      `Platform: ${info.platform}`,
    ];

    if (Object.keys(info.preferences).length > 0) {
      const prefs = Object.entries(info.preferences)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      parts.push(`Prefs: ${prefs}`);
    }

    return parts.join(", ");
  }
}
