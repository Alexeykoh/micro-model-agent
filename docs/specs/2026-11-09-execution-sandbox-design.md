# Спека: профиль исполнения `execution.profile` (P0 изоляция, 1/2)

Дата: 2026-11-09. Ветка: `feat/execution-sandbox` (ветка 1/2:
профиль + runner + preflight; cert-сценарии и Dockerfile приёмки — 2/2).
Источник: `TODO.md §3 P0 Изоляция исполнения`,
[`2026-09-28-production-readiness`](../archive/specs/2026/2026-09-28-production-readiness-design.md) §3.

## Что неправильно

Enforcement (`ToolExecutor.execute`: allowlist, protected-пути, SSRF, теги,
rate-limit; файловые тулы — jail + write-allowlist) — в одной точке, но
`bash` изпълняется напрямую на хосте (`spawn`, shell). Успешный
prompt-injection = RCE на хосте.

## Контракт

1. **Конфиг:** `execution.profile: "local-trusted" | "sandbox"`, дефолт
   `local-trusted` (1:1 поведение со старым). `execution.image: string`,
   дефолт `oven/bun:1.3.14` (фикс. образ рантайма Bung).
   i18n `config.key/desc.execution.profile`, `config.enum.local-trusted`,
   `config.enum.sandbox` (en+ru).
2. **Sandbox-runner** (`src/tools/bash-docker.ts`): при `sandbox` bash-тул
   запускает команду через
   `docker run --rm --read-only --network none --cap-drop ALL
   --security-opt no-new-privileges=true -u 1000:1000
   -v <baseDir>:/work --workdir /work -e HOME=/work <image> bash -lc <cmd>`.
   - egress deny-by-default: `--network none` (web-тулы не меняются —
     их egress-политика уже в ToolExecutor).
   - env провайдеров/ключей в контейнер не пробрасываются.
   - timeout + abort — как у нативного пути (тот же контракт `ToolResult`);
     убитый/невалидный docker → `success:false` с причиной.
   - Файловые тулы оставляет на хосте за существующим jail (deny вне baseDir
     структурно включён); mount `/work` — rw, чтобы bash-билды писали
     в то же дерево.
3. **Fail-closed preflight:** `sandbox` + недоступный/отсутствующий Docker
   (CLI нет / daemon отвечает ошибкой) → ход заканчивается ошибкой
   `execution.sandbox_unavailable` (лог `diagnostic`), а не деградацией
   до `local-trusted`.
4. **Fail-open путь:** `local-trusted` — исполнение прежним путём, без
   docker-вызовов (включая отсутствие docker).

## Приёмка

- Тесты оффлайн: сканирование argv docker-runner (стоп-флаги, env без
  ключей, mount только baseDir), preflight-фейлы (mockSpawn ENOENT),
  `local-trusted` не зовёт docker (spy).
- Живой прогон после старта docker-daemon: sandbox bash пишет в baseDir
  (файл виден снаружи), запись в `/tmp`-за пределами mount недоступна,
  egress (`curl https://example.com`) отклоняется.
- `bun run typecheck`/`bun test` (skipped docker-тесты при отсутствии
  daemon), `bun run lint` зелёные.
