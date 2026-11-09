# Спека: daemon wire — разделение UI / runtime (P1 монолит, волна -1)

Дата: 2026-11-09. Ветка `feat/daemon-wire` внутри `dev_0_25_0`.
Идея: `docs/ideas/2026-11-09-mma-enterprise-separate-version.md` §3.5.

## Проблема

`CLI/REPL/WebHost` и `Agent` общаются in-process через `Host`
(`src/core/host.ts`). Пока UI живёт в том же процессе, недоступны:
control plane, thin-режим, отзыв доступа, централизованный аудит.

## Контракт волны -1

1. **Wire-транспорт:** `mma serve` (daemon) отдаёт `Host`-поверхность по
   HTTP+SSE на `127.0.0.1` (уже есть: Agent Service API `/v1` + SSE pull/resume).
   UI — тонкий клиент этого API (web уже такой; REPL/TUI — будущие клиенты).
2. **Токен:** bearer-токен процесса хранится в OS keychain, fallback —
   файл `~/.mma/daemon.token` (0600). Клиент читает токен из файла/env
   (`MMA_DAEMON_TOKEN` / `MMA_SERVICE_TOKEN`).
3. **Версионирование протокола:** `PROTOCOL_VERSION = "1"` в
   `src/modules/daemon/protocol.ts`; `/v1/health` отдаёт `protocol: "1"`;
   клиент отвергает чужой major (fail-fast, не молча).
4. **Daemon переживает рестарт UI:** состояние хода — в сессии
   (`session.jsonl`, `checkpoint.json`, `interrupt.json`); SSE pull
   (`GET /v1/sessions/:id/events?since=`) продолжает поток после
   переподключения. UI-клиент переподключается без потери хода.
5. **Отзыв доступа:** удаление токена / смена `service.token` + рестарт
   демона отзывает все клиенты (single-process revocation, silo).

## Критерий закрытия волны -1

- `src/modules/daemon/protocol.ts` (версия + токен-файл + thin-клиент);
- `/v1/health` несёт `protocol`;
- тест: клиент с неверной major-версией отвергается;
- доки (`docs/agents/service-api.md`, `deploy/RUNBOOK.md`) описывают
  daemon/UI разделение.

Полное разделение REPL/TUI в thin-клиенты — вне волны -1 (web уже thin).
