// Дефолтные LSP-серверы и выбор сервера по файлу (язык, Angular-исключение).
import { existsSync } from "fs";
import { dirname, join } from "path";
import type { LspConfig, LspServerConfig } from "./types";
import { serverKeyForPath } from "./language";

/**
 * Дефолты LSP-серверов.
 * Стратегия: предпочитать `npx` (самодокачка) глобальным бинарникам.
 * Серверы на системных тулах (rust-analyzer, gopls) — `autoInstall: false`,
 * при отсутствии молча скипаются.
 */
export const DEFAULT_LSP_CONFIG: LspConfig = {
  enabled: true,
  timeout: 15000,
  typescriptEngine: "typescript-language-server",
  servers: {
    typescript: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "typescript-language-server",
        "--package",
        "typescript@5",
        "typescript-language-server",
        "--stdio",
      ],
      timeout: 30000,
      autoInstall: true,
      workspaceMarkers: ["package.json", "tsconfig.json"],
    },
    /**
     * Нативный TS-сервер (`tsgo`, TypeScript 7 preview). Не автоустанавливается:
     * нет бинарника — молчаливый скип, как у rust-analyzer/gopls. Выбирается
     * через `lsp.typescriptEngine: "tsgo"`.
     */
    "typescript-native": {
      command: "tsgo",
      args: ["--lsp", "--stdio"],
      timeout: 30000,
      autoInstall: false,
      workspaceMarkers: ["package.json", "tsconfig.json"],
    },
    javascript: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "typescript-language-server",
        "--package",
        "typescript@5",
        "typescript-language-server",
        "--stdio",
      ],
      timeout: 30000,
      autoInstall: true,
      workspaceMarkers: ["package.json", "tsconfig.json"],
    },
    python: {
      command: "npx",
      // `pyright` — CLI; LSP-энтрипоинт пакета называется `pyright-langserver`.
      // С `npx pyright --stdio` процесс печатает справку и выходит, поэтому
      // python-файлы никогда не проверялись (живой прогон: «LSP server exited»).
      args: ["--yes", "--package", "pyright", "pyright-langserver", "--stdio"],
      timeout: 15000,
      autoInstall: true,
      workspaceMarkers: ["pyproject.toml", "setup.py", "requirements.txt"],
    },
    rust: {
      command: "rust-analyzer",
      timeout: 15000,
      autoInstall: false,
      workspaceMarkers: ["Cargo.toml"],
    },
    go: {
      command: "gopls",
      timeout: 15000,
      autoInstall: false,
      workspaceMarkers: ["go.mod"],
    },
    json: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "vscode-langservers-extracted",
        "vscode-json-language-server",
        "--stdio",
      ],
      timeout: 30000,
      autoInstall: true,
      workspaceMarkers: ["package.json"],
    },
    html: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "vscode-langservers-extracted",
        "--package",
        "typescript@5",
        "vscode-html-language-server",
        "--stdio",
      ],
      timeout: 60000,
      autoInstall: true,
      workspaceMarkers: ["package.json"],
    },
    css: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "vscode-langservers-extracted",
        "--package",
        "typescript@5",
        "vscode-css-language-server",
        "--stdio",
      ],
      timeout: 60000,
      autoInstall: true,
      workspaceMarkers: ["package.json"],
    },
    angular: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "@angular/language-server",
        "--package",
        "typescript@5",
        "ngserver",
        "--stdio",
        "--tsProbeLocations",
        "./node_modules",
        "--ngProbeLocations",
        "./node_modules",
      ],
      timeout: 60000,
      autoInstall: true,
      workspaceMarkers: ["angular.json"],
    },
  },
};

/** Ключ конфигурации LSP-сервера (язык индексатора), без Angular-логики. */
function languageServerKey(filePath: string): string | null {
  return serverKeyForPath(filePath);
}

const ANGULAR_MARKER = "angular.json";
const ANGULAR_LOOKUP_DEPTH = 10;

/**
 * Лежит ли файл внутри Angular-workspace (маркер `angular.json` в одном из
 * предков, поиск ограничен глубиной).
 */
function isAngularProject(filePath: string): boolean {
  let dir = dirname(filePath);
  for (let i = 0; i < ANGULAR_LOOKUP_DEPTH; i++) {
    if (existsSync(join(dir, ANGULAR_MARKER))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * Ключ конфига LSP-сервера для файла. `.html` идёт на сервер `angular` внутри
 * Angular-workspace (шаблонам с биндингами нужен Angular language service),
 * везде иначе — на generic `html`.
 */
export function getServerKeyForFile(filePath: string, config: LspConfig): string | null {
  const lang = languageServerKey(filePath);
  if (!lang) return null;
  if (lang === "html" && config.servers.angular && isAngularProject(filePath)) {
    return "angular";
  }
  return engineKey(lang, config);
}

/**
 * Замена классического TS-сервера нативный `tsgo`, когда выбран этот движок.
 * Ключ `typescript`/`javascript` указывает на запись `typescript-native`; если
 * её нет в конфиге (старый файл), остаётся классический сервер.
 */
function engineKey(key: string, config: LspConfig): string {
  if (config.typescriptEngine !== "tsgo") return key;
  if (key !== "typescript" && key !== "javascript") return key;
  return config.servers["typescript-native"] ? "typescript-native" : key;
}

/** Конфиг LSP-сервера для файла (null — не поддерживается). */
export function getServerForFile(filePath: string, config: LspConfig): LspServerConfig | null {
  const key = getServerKeyForFile(filePath, config);
  if (!key) return null;
  return config.servers[key] ?? null;
}

/** Алиасы языковых id индексатора к ключам серверов LSP. */
const LANGUAGE_ALIAS: Record<string, string> = {
  "typescript-react": "typescript",
  "javascript-react": "javascript",
  typescript: "typescript",
  javascript: "javascript",
};

/** Ключ сервера LSP по языковому id индексатора (напр. `typescript-react` → `typescript`). */
export function getServerKeyForLanguage(language: string, config: LspConfig): string | null {
  const key = LANGUAGE_ALIAS[language] ?? language;
  return config.servers[key] ? key : null;
}

/** Конфиг LSP-сервера по языковому id (null — нет сервера для языка). */
export function getServerForLanguage(
  language: string,
  config: LspConfig,
): LspServerConfig | null {
  const key = getServerKeyForLanguage(language, config);
  if (!key) return null;
  return config.servers[engineKey(key, config)] ?? null;
}
