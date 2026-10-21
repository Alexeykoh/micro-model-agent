// Общие списки опасных команд безопасности — единый источник для пресетов
// политики (`security-policies.ts`) и дефолтного конфига (`config/security.ts`).
// Дублировать списки в трёх местах означало бы, что расширить их можно только
// в одном — и забыть про остальные.

/**
 * База чёрного списка bash-команд (пресеты strict и balanced).
 * Разрушающие файлы/систему, обход сети, изменение учёток.
 */
export const BASE_BLACKLIST: readonly string[] = [
  "rm",
  "dd",
  "chmod",
  "wget",
  "curl",
  "scp",
  "ssh",
  "nc",
  "netcat",
  "mknod",
  "mkfifo",
  "useradd",
  "usermod",
  "passwd",
  "sudo",
  "su",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "format",
  "fdisk",
  "parted",
  "mkfs",
];

/**
 * Экстра строгого пресета: права, процессы, перемещение/копирование.
 */
export const STRICT_EXTRA_BLACKLIST: readonly string[] = [
  "ln",
  "chown",
  "chgrp",
  "kill",
  "pkill",
  "killall",
  "exec",
  "eval",
  "source",
  "mv",
  "cp",
  "mount",
  "umount",
];

/**
 * Опасные в ЛЮБОМ пресете (аудит §4.10/§4.11): реестр Windows, смена прав,
 * крипто-утилиты, скриптовые хосты, многоформатные утилиты, рекурсивное
 * удаление. Обход защиты: ими можно стереть данные, снять права, спрятать
 * исполняемый код или вызвать произвольную команду.
 */
export const DANGEROUS_COMMANDS: readonly string[] = [
  // Реестр и права Windows.
  "reg",
  "takeown",
  "icacls",
  "attrib",
  "certutil",
  "bitsadmin",
  "diskpart",
  // Скриптовые хосты (выполняют код из файла/строки).
  "wscript",
  "cscript",
  "mshta",
  // Уничтожение данных и «многоформатные» утилиты.
  "shred",
  "truncate",
  "unlink",
  "busybox",
  // Рекурсивное удаление (del/rd уже в базовом списке дефолтного конфига).
  "del",
  "rd",
  "erase",
  "rmdir",
];

/** Минимальный чёрный список (пресет permissive). */
export const PERMISSIVE_BLACKLIST: readonly string[] = [
  "rm",
  "dd",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "format",
  "fdisk",
  "parted",
  "mkfs",
];
