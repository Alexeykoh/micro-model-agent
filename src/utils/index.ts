// Общие утилиты без зависимостей: сон, обрезка строк, бэкофф, ошибки, child-процессы.
export { sleep } from "./sleep";
export { truncate } from "./truncate";
export { backoffDelay } from "./retry";
export { errMsg } from "./error";
export { settleChildClose } from "./child-run";
export type { ChildRunOutput } from "./child-run";