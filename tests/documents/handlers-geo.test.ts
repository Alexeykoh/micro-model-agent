import { describe, expect, it } from "vitest";
import { DEFAULT_DOC_LIMITS } from "../../src/modules/documents/bound";
import { GEO_OUTLINE_CAP, geojsonHandler, gpxHandler } from "../../src/modules/documents/handlers/geo";
import { buildRegistry } from "../../src/modules/documents/registry";
import type { Logger } from "../../src/logger/app-logger";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const ctx = { logger, limits: DEFAULT_DOC_LIMITS };
const src = (path: string, text: string) => ({
  path,
  display: path,
  ext: path.slice(path.lastIndexOf(".")).toLowerCase(),
  bytes: async () => new TextEncoder().encode(text),
});

const GEOJSON = JSON.stringify({
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: "Alpha" }, geometry: null },
    { type: "Feature", properties: { title: "Beta" }, geometry: null },
    { type: "Feature", id: "gamma", properties: {}, geometry: null },
    { type: "Feature", properties: {}, geometry: null },
  ],
});

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <wpt lat="1" lon="2"><name>W1</name></wpt>
  <rte><name>R1</name></rte>
  <trk><name>T1</name><trkseg><trkpt lat="1" lon="2"/></trkseg></trk>
</gpx>`;

describe("geojsonHandler", () => {
  it("FeatureCollection → узел outline на фичу (name/title/id/фолбэк)", async () => {
    const ir = await geojsonHandler.parse(ctx, src("a.geojson", GEOJSON));
    expect(ir.outline.map((n) => n.title)).toEqual(["Alpha", "Beta", "gamma", "feature 4"]);
    expect(ir.meta.format).toBe("geojson");
    expect(ir.meta.title).toBe("a.geojson");
  });

  it("кладёт bounded code-блок с JSON", async () => {
    const ir = await geojsonHandler.parse(ctx, src("a.geojson", GEOJSON));
    const code = ir.blocks.find((b) => b.kind === "code");
    if (!code || code.kind !== "code") throw new Error("expect code");
    expect(code.lang).toBe("json");
    expect(code.text).toContain("FeatureCollection");
  });

  it("невалидный GeoJSON → meta.degraded и сырой текст", async () => {
    const ir = await geojsonHandler.parse(ctx, src("a.geojson", "{не json"));
    expect(ir.meta.degraded).toBeTruthy();
    expect(ir.blocks.some((b) => b.kind === "code")).toBe(true);
  });

  it("не заявляет .json (его берёт json.ts)", () => {
    expect(geojsonHandler.extensions).toContain(".geojson");
    expect(geojsonHandler.extensions).not.toContain(".json");
  });

  it("фича без properties не падает и получает фолбэк-заголовок", async () => {
    const ir = await geojsonHandler.parse(
      ctx,
      src("a.geojson", JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature" }] })),
    );
    expect(ir.outline[0].title).toBe("feature 1");
  });

  it("огромный FeatureCollection → outline усечён до капа с честной деградацией", async () => {
    const features = Array.from({ length: GEO_OUTLINE_CAP + 5 }, (_, i) => ({
      type: "Feature",
      properties: { name: `F${i}` },
      geometry: null,
    }));
    const ir = await geojsonHandler.parse(
      ctx,
      src("big.geojson", JSON.stringify({ type: "FeatureCollection", features })),
    );
    expect(ir.outline.length).toBeLessThanOrEqual(GEO_OUTLINE_CAP + 1);
    expect(ir.outline.at(-1)?.title).toContain("outline capped");
    expect(ir.meta.degraded?.reason).toContain("capped");
  });
});

describe("gpxHandler", () => {
  it("wpt/rte/trk → узлы outline по именам", async () => {
    const ir = await gpxHandler.parse(ctx, src("t.gpx", GPX));
    const titles = ir.outline.map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining(["W1", "R1", "T1"]));
    expect(ir.meta.format).toBe("gpx");
  });

  it("без имени даёт фолбэк-заголовок", async () => {
    const ir = await gpxHandler.parse(ctx, src("t.gpx", '<gpx><wpt lat="1" lon="2"/></gpx>'));
    expect(ir.outline[0].title).toBe("wpt 1");
  });

  it("не-xml мусор → meta.degraded", async () => {
    const ir = await gpxHandler.parse(ctx, src("t.gpx", "not xml at all"));
    expect(ir.meta.degraded).toBeTruthy();
  });

  it("пустой <gpx/> без wpt/rte/trk — пустой outline, без падения и деградации", async () => {
    const ir = await gpxHandler.parse(ctx, src("e.gpx", "<gpx></gpx>"));
    expect(ir.outline).toHaveLength(0);
    expect(ir.meta.degraded).toBeUndefined();
    expect(ir.blocks.some((b) => b.kind === "code")).toBe(true);
  });

  it("не заявляет .xml/.svg (их берёт xml.ts)", () => {
    expect(gpxHandler.extensions).toContain(".gpx");
    expect(gpxHandler.extensions).not.toContain(".xml");
    expect(gpxHandler.extensions).not.toContain(".svg");
  });
});

describe("geo: реестр", () => {
  it(".geojson резолвится под группой geo", () => {
    const reg = buildRegistry({ enabled: true, groups: ["geo"], handlers: [geojsonHandler, gpxHandler] });
    expect(reg.resolve("a.geojson", new Uint8Array([0x7b]))?.id).toBe("geojson");
  });
  it(".gpx резолвится под группой geo", () => {
    const reg = buildRegistry({ enabled: true, groups: ["geo"], handlers: [geojsonHandler, gpxHandler] });
    expect(reg.resolve("a.gpx", new Uint8Array([0x3c, 0x3f]))?.id).toBe("gpx");
  });
});
