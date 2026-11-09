# Sandbox-образ для execution.profile=sandbox (P0 изоляция, 2/2).
# Спека: docs/specs/2026-11-09-execution-sandbox-design.md
# Сборка: docker build -t mma-sandbox:0.1.0 .
# Запуск раннером: execution.image = "mma-sandbox:0.1.0"
#
# База — oven/bun (тот же рантайм, что и хост MMA), минимальный набор
# инструментов: bash (ENTRYPOINT раннера), git (для plan/verify-шагов),
# ca-certificates + tzdata (для egress-проверок fail-closed на --network none).
# Без curl/wget намеренно не ставим: egress запрещён политикой раннера,
# а не отсутствием бинарника — тесты sandbox-live проверяют это честно
# (fetch вызывает реальную DNS/TCP-попытку).
FROM oven/bun:1.3.14

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

# Контейнер работает от nobody-совместимого UID 1000 (см. -u в раннере);
# /work — mount baseDir хоста (rw внутри read-only rootfs раннера).
WORKDIR /work
USER 1000:1000

# bash — точка входа раннера (ENTRYPOINT раннерами задаётся явно).
CMD ["bash", "--version"]
