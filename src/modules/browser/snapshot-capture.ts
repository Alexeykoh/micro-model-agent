// Снимок страницы браузера: HTML, текст, интерактивные элементы.
//
// Вынесено из `session.ts`: сбор снимка — самостоятельный шов (он же нужен
// для других драйверов), а сессия держит только состояние.
import { buildIndexInjectionScript, buildTextExtractionScript } from "./actions";
import { extractInteractiveElements, formatSnapshot } from "./snapshot";
import { wrapUntrusted } from "../../tools/web-content";
import type { BrowserDriver } from "./driver-types";
import type { BrowserConfig, BrowserState } from "./types";

/** Снимок страницы: текст для модели и состояние браузера. */
export interface SnapshotCapture {
  text: string;
  state: BrowserState;
}

/**
 * Собирает снимок открытой страницы: индексирует элементы, вытаскивает
 * видимый текст, режет список до лимита.
 */
export async function captureSnapshot(
  driver: BrowserDriver,
  config: BrowserConfig,
): Promise<SnapshotCapture> {
  await driver.evaluate(buildIndexInjectionScript());
  const html = await driver.content();
  const url = driver.url();
  const title = await driver.title();

  let content = "";
  try {
    content = String(await driver.evaluate(buildTextExtractionScript()));
  } catch {
    content = "";
  }

  const allElements = extractInteractiveElements(html, config.maxElements + 5);
  const truncated = allElements.length > config.maxElements;
  const elements = allElements.slice(0, config.maxElements);

  const state: BrowserState = {
    isOpen: true,
    url,
    title,
    elementCount: elements.length,
  };

  const text = formatSnapshot({
    url,
    title,
    elements,
    content,
    console: driver.getConsole(),
    networkErrors: driver.getNetworkErrors(),
    truncated,
  });
  // Содержимое страницы — недоверенные данные (аудит §2.14).
  return { text: wrapUntrusted(url, text), state };
}
