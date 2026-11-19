/**
 * Сквозная интеграция `mma serve` + тонкие клиенты (спека §16).
 *
 * Проверяем то, что нельзя проверить на маппере: настоящий сервис, несколько
 * SSE-подписчиков одной сессии, HITL-вопрос без привязки к соединению,
 * переподключение и FIFO-очередь ходов.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../src/core/types";
import type { PromptIO } from "../src/tools/prompt-io";
import { startAgentService } from "../src/modules/service/module";
import { RemoteHost } from "../src/modules/daemon/remote-host";
import type { HostEvent } from "../src/core/host";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./service/harness";

let dir: string;
let stop: (() => void) | undefined;
let base: string;
let sessionId: string;
const hosts: RemoteHost[] = [];

function newHost(id = sessionId): RemoteHost {
  const host = new RemoteHost({ baseUrl: base, sessionId: id });
  hosts.push(host);
  return host;
}

/** Агент, который спрашивает и возвращает полученный ответ. */
function askingAgent(state: { io?: PromptIO }) {
  return {
    setPromptIO(io: PromptIO) {
      state.io = io;
    },
    async run(input: string, onChunk?: (c: string) => void): Promise<AgentResult> {
      const answer = await state.io!.askText(`answer "${input}"?`);
      onChunk?.(`\n${answer}`);
      return { success: true, text: answer, iterationCount: 1 };
    },
    shutdown() {},
    pause() {},
    resume() {},
  };
}

/** Агент-эхо: первый ход висит на `gate`, второй проходит сразу (FIFO). */
function gatedEchoAgent(gate: { release: () => void }) {
  return {
    setPromptIO() {},
    async run(input: string): Promise<AgentResult> {
      if (input === "one") await new Promise<void>((resolve) => (gate.release = resolve));
      return { success: true, text: input, iterationCount: 1 };
    },
    shutdown() {},
    pause() {},
    resume() {},
  };
}

async function start(agent: unknown): Promise<void> {
  const svc = startAgentService(makeServiceDeps({ dir, agent }));
  stop = svc.stop;
  base = await svc.url;
  sessionId = await firstSessionId(base);
}

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  dir = tempServiceDir();
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
  hosts.length = 0;
});

describe("daemon integration: two clients on one session (W9)", () => {
  it("shows the same question to both clients and lets the first answer win", async () => {
    const state: { io?: PromptIO } = {};
    await start(askingAgent(state));

    const a = newHost();
    const b = newHost();
    const eventsA: HostEvent[] = [];
    const eventsB: HostEvent[] = [];
    a.subscribeEvents((ev) => eventsA.push(ev));
    b.subscribeEvents((ev) => eventsB.push(ev));

    await a.submit("color");
    await waitFor(() => eventsA.some((e) => e.type === "question"));
    await waitFor(() => eventsB.some((e) => e.type === "question"));

    const idA = (eventsA.find((e) => e.type === "question")!.data as { id: string }).id;
    const idB = (eventsB.find((e) => e.type === "question")!.data as { id: string }).id;
    expect(idA).toBe(idB);

    await b.answer(idA, "blue");
    await waitFor(() => eventsA.some((e) => e.type === "task.finished"));

    const finished = eventsA.find((e) => e.type === "task.finished");
    expect((finished!.data as { result: { text: string } }).result.text).toBe("blue");

    // Первый ответ уже закрыл вопрос: повторный не должен разблокировать что-то ещё.
    await expect(a.answer(idA, "red")).rejects.toThrow(/404/);
  });

  it("delivers a pending question to a client that (re)connects later", async () => {
    const state: { io?: PromptIO } = {};
    await start(askingAgent(state));

    const first = newHost();
    const seen: HostEvent[] = [];
    first.subscribeEvents((ev) => seen.push(ev));
    await first.submit("reconnect");
    await waitFor(() => seen.some((e) => e.type === "question"));
    const id = (seen.find((e) => e.type === "question")!.data as { id: string }).id;

    // Новый клиент не видел поток: сервер обязан отдать вопрос из буфера сессии.
    const late = newHost();
    const lateSeen: HostEvent[] = [];
    late.subscribeEvents((ev) => lateSeen.push(ev));
    await waitFor(() => lateSeen.some((e) => e.type === "question"));
    expect((lateSeen.find((e) => e.type === "question")!.data as { id: string }).id).toBe(id);

    await late.answer(id, "late-but-valid");
    await waitFor(() => seen.some((e) => e.type === "task.finished"));
    expect(
      (seen.find((e) => e.type === "task.finished")!.data as { result: { text: string } }).result
        .text,
    ).toBe("late-but-valid");
  });

  it("runs two submits on one session FIFO (single-flight)", async () => {
    const gate = { release: () => {} };
    await start(gatedEchoAgent(gate));

    const a = newHost();
    const events: HostEvent[] = [];
    a.subscribeEvents((ev) => events.push(ev));

    await a.submit("one");
    await a.submit("two");
    await waitFor(() => events.some((e) => e.type === "task.started"));

    gate.release();
    await waitFor(() => events.filter((e) => e.type === "task.finished").length === 2);

    const finished = events
      .filter((e) => e.type === "task.finished")
      .map((e) => (e.data as { result: { text: string } }).result.text);
    expect(finished).toEqual(["one", "two"]);
  });
});
