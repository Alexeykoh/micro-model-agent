// REST-хендлер i18n-поверхности `mma web`: словарь для локализации chrome браузера.
/**
 * Статика браузера локализуется из отдаваемого здесь словаря; вывод
 * модели/тулов локализуется на сервере. Вынесен из `server.ts`
 * (правило #1: ≤300 строк/файл). Auth и same-origin — выше по потоку.
 */
import type { ServerResponse } from "node:http";
import { getFlatDicts } from "../../../i18n/index";
import { sendJson } from "../util";
import type { ConfigStore } from "../state";
import { isI18nStale } from "./i18n-stale";

/** `GET /api/i18n` — текущая локаль конфига + все плоские словари. */
export function handleI18nGet(res: ServerResponse, s: ConfigStore): void {
  sendJson(res, 200, {
    locale: s.config?.locale ?? "en",
    dicts: getFlatDicts(),
    // Словари на диске новее процесса — клиенту нужен рестарт сервера.
    i18nStale: isI18nStale(),
  });
}
