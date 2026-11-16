/**
 * W10: маппинг новых host-событий в веб-SSE — `log`, `subagent` и картинки
 * тула из `imageRefs`.
 */
import { describe, expect, it } from "vitest";
import { mapHostEvent } from "../src/modules/webui/daemon-events";

const base = { ts: 1, sessionId: "S1" };

describe("daemon events mapping (W10)", () => {
  it("maps log events", () => {
    expect(
      mapHostEvent({
        ...base,
        type: "log",
        data: { level: "warn", source: "core", text: "slow probe", diagnostic: true },
      }),
    ).toMatchObject({
      type: "log",
      level: "warn",
      source: "core",
      text: "slow probe",
      diagnostic: true,
    });
  });

  it("maps subagent wire objects without leaking their own envelope fields", () => {
    const mapped = mapHostEvent({
      ...base,
      type: "subagent",
      data: {
        type: "subagent",
        ts: 5,
        sessionId: "S1",
        seq: 2,
        kind: "start",
        runId: "run-1",
        parentToolCallId: "t1",
      },
    });
    expect(mapped).toMatchObject({
      type: "subagent",
      ts: 1,
      sessionId: "S1",
      kind: "start",
      runId: "run-1",
      parentToolCallId: "t1",
    });
    expect(mapped?.ts).toBe(1);
  });

  it("builds image URLs from saved refs, else passes inline data URLs", () => {
    expect(
      mapHostEvent({
        ...base,
        type: "tool.end",
        data: { toolCallId: "t", name: "screenshot", imageRefs: ["shot-1.png"] },
      }),
    ).toMatchObject({ type: "tool_end", images: ["/api/sessions/S1/images/shot-1.png"] });

    expect(
      mapHostEvent({
        ...base,
        type: "tool.end",
        data: {
          toolCallId: "t",
          name: "screenshot",
          images: ["data:image/png;base64,AA=="],
        },
      }),
    ).toMatchObject({ type: "tool_end", images: ["data:image/png;base64,AA=="] });
  });
});
