/**
 * Резолвер состояния файлов для проверки заявлений (Fix B2).
 *
 * Извлекает файлоподобные токены из финального ответа, смотрит их под baseDir
 * и парсит машинопроверяемые форматы: JSON через `JSON.parse`, семейство XML
 * через `checkXmlWellFormed`. Форматы с компилятором (TS/JS) — только existence:
 * сборка внутри гейта была бы медленной и флаки, а плановые работы и так
 * покрывает верификатор плана.
 *
 * Ограничен (макс. путей, макс. байт) и в jail: токены вне baseDir
 * пропускаются, не читаются.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { extractFileLikeTokens } from "../../core/hallucination/js-identifiers";
import type { ArtifactState } from "../../core/hallucination/artifact-claim";
import { checkXmlWellFormed } from "../../tools/syntax-validator";
import { findExistingFile } from "../../modules/execution/auditor";

const MAX_PATHS = 10;
const MAX_BYTES = 500 * 1024;

const JSON_EXTS = new Set([".json", ".jsonc"]);
const XML_EXTS = new Set([".xml", ".drawio", ".svg", ".xaml", ".plist", ".iml"]);

function parseIfSupported(ext: string, content: string): string | undefined {
  if (JSON_EXTS.has(ext)) {
    try {
      JSON.parse(content);
      return undefined;
    } catch (e) {
      return `invalid JSON: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
    }
  }
  if (XML_EXTS.has(ext)) {
    return checkXmlWellFormed(content) ?? undefined;
  }
  return undefined;
}

/**
 * Резолвит состояния артефактов, упомянутых в ответе (в пределах baseDir).
 * @param baseDir корень workspace (jail); @param response финальный ответ модели.
 * @returns состояния найденных артефактов (существует/ошибка парсинга).
 */
export function resolveArtifactStates(baseDir: string, response: string): ArtifactState[] {
  if (!response) return [];
  const out: ArtifactState[] = [];
  for (const token of extractFileLikeTokens(response).slice(0, MAX_PATHS)) {
    const abs = isAbsolute(token) ? token : resolve(baseDir, token);
    const rel = relative(baseDir, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const state = resolveOneArtifact(token, baseDir);
    if (state) out.push(state);
  }
  return out;
}

/**
 * Смотрит один путь внутри jail (и парсит, если формат поддерживается).
 * Точный резолв первым, затем поиск по basename/суффиксу в поддереве:
 * ответ часто называет файл голым именем ("game.ts"), а лежит он в `src/`
 * — строгий резолв давал exists:false и ложный claim-retry с дублем
 * ответа в ленте (ses_munvrcfz_na9ze3). Null, если нечитаем.
 */
function resolveOneArtifact(token: string, baseDir: string): ArtifactState | null {
  // findExistingFile сам идёт в jail baseDir: точный путь, иначе basename/суффикс.
  const found = findExistingFile(baseDir, token);
  if (!found) return { path: token, exists: false };
  let size: number;
  try {
    const st = statSync(found);
    if (!st.isFile()) return { path: token, exists: false };
    size = st.size;
  } catch {
    return { path: token, exists: true };
  }
  if (size > MAX_BYTES) return { path: token, exists: true };
  let content: string;
  try {
    content = readFileSync(found, "utf-8");
  } catch {
    // Нечитаем между stat и read — существует, но не проверен.
    return { path: token, exists: true };
  }
  return { path: token, exists: true, parseError: parseIfSupported(extname(token).toLowerCase(), content) };
}
