/**
 * Host-wire операции «панелей» (memory/skills/setup/index/lsp) — вынесены
 * из `operations-host.ts` по правилу ≤300 строк.
 */
import { ok, PROBLEM_RESPONSES, type SpecOperation } from "./operation-types";

export const HOST_MISC_OPERATIONS: SpecOperation[] = [
  {
    method: "get",
    path: "/v1/host/memory",
    operationId: "hostMemory",
    tag: "host",
    summary: "Память: преференции и записи по категориям",
    responses: { "200": ok("Память"), "503": ok("Модуль памяти недоступен", "ProblemDetails"), ...PROBLEM_RESPONSES },
  },
  {
    method: "get",
    path: "/v1/host/skills",
    operationId: "hostSkills",
    tag: "host",
    summary: "Доступные скиллы и флаг загруженности",
    responses: { "200": ok("Скиллы"), "503": ok("Модуль скиллов недоступен", "ProblemDetails"), ...PROBLEM_RESPONSES },
  },  {
    method: "get",
    path: "/v1/host/setup",
    operationId: "hostSetup",
    tag: "host",
    summary: "Display-данные визарда настройки",
    responses: { "200": ok("Языки/провайдеры/дефолты"), ...PROBLEM_RESPONSES },
  },
  {
    method: "post",
    path: "/v1/host/index",
    operationId: "hostIndex",
    tag: "host",
    summary: "Пересобрать карту проекта",
    responses: { "202": ok("Пересборка запущена"), "503": ok("Индексер недоступен", "ProblemDetails"), ...PROBLEM_RESPONSES },
  },
  {
    method: "get",
    path: "/v1/host/lsp",
    operationId: "hostLspFlags",
    tag: "host",
    summary: "Флаги LSP (enabled/offline)",
    responses: { "200": ok("Флаги"), "503": ok("LSP недоступен", "ProblemDetails"), ...PROBLEM_RESPONSES },
  },
  {
    method: "get",
    path: "/v1/host/lsp/doctor",
    operationId: "hostLspDoctor",
    tag: "host",
    summary: "Диагностика LSP workspace",
    responses: { "200": ok("Диагностика"), "500": ok("Ошибка LSP", "ProblemDetails"), "503": ok("LSP недоступен", "ProblemDetails"), ...PROBLEM_RESPONSES },
  },  {
    method: "get",
    path: "/v1/host/plugins",
    operationId: "hostPlugins",
    tag: "host",
    summary: "Плагины, отказы загрузки и MCP-серверы",
    responses: { "200": ok("Плагины"), "503": ok("Плагины недоступны", "ProblemDetails"), ...PROBLEM_RESPONSES },
  },
];
