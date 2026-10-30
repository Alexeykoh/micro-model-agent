// Lucide icon table (MIT) for the web chrome. Split out of dom.ts so the
// element builders stay under the 300-line rule; dom.ts re-uses it via icon().
// Chat status glyphs (◇ ✓ ✗ ✦ ⟡ …) stay textual per docs/design/ui/STYLE.md.
export type IconSpec = Array<[string, Record<string, string | number>]>;
export const ICONS: Record<string, IconSpec> = {
  plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
  menu: [
    ["line", { x1: 4, y1: 6, x2: 20, y2: 6 }],
    ["line", { x1: 4, y1: 12, x2: 20, y2: 12 }],
    ["line", { x1: 4, y1: 18, x2: 20, y2: 18 }],
  ],
  settings: [
    [
      "path",
      {
        d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      },
    ],
    ["circle", { cx: 12, cy: 12, r: 3 }],
  ],
  image: [
    ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }],
    ["circle", { cx: 9, cy: 9, r: 2 }],
    ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }],
  ],
  x: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  trash: [
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }],
    ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
    ["line", { x1: 10, y1: 11, x2: 10, y2: 17 }],
    ["line", { x1: 14, y1: 11, x2: 14, y2: 17 }],
  ],
  refresh: [
    ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }],
    ["path", { d: "M21 3v5h-5" }],
    ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }],
    ["path", { d: "M8 21H3v-5" }],
  ],
  "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]],
  "chevron-left": [["path", { d: "m15 18-6-6 6-6" }]],
  "chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
  search: [
    ["circle", { cx: 11, cy: 11, r: 8 }],
    ["path", { d: "m21 21-4.3-4.3" }],
  ],
  "list-checks": [
    ["path", { d: "m3 17 2 2 4-4" }],
    ["path", { d: "m3 7 2 2 4-4" }],
    ["path", { d: "M13 6h8" }],
    ["path", { d: "M13 12h8" }],
    ["path", { d: "M13 18h8" }],
  ],
  "layout-grid": [
    ["rect", { width: 7, height: 7, x: 3, y: 3, rx: 1 }],
    ["rect", { width: 7, height: 7, x: 14, y: 3, rx: 1 }],
    ["rect", { width: 7, height: 7, x: 14, y: 14, rx: 1 }],
    ["rect", { width: 7, height: 7, x: 3, y: 14, rx: 1 }],
  ],
  code: [
    ["path", { d: "m16 18 6-6-6-6" }],
    ["path", { d: "m8 6-6 6 6 6" }],
  ],
  plug: [
    ["path", { d: "M12 22v-5" }],
    ["path", { d: "M9 8V2" }],
    ["path", { d: "M15 8V2" }],
    ["path", { d: "M18 8v5a6 6 0 0 1-12 0V8Z" }],
  ],
  activity: [
    [
      "path",
      {
        d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
      },
    ],
  ],
  "arrow-up": [["path", { d: "M12 19V5" }], ["path", { d: "m5 12 7-7 7 7" }]],
  "arrow-left": [["path", { d: "M19 12H5" }], ["path", { d: "m12 19-7-7 7-7" }]],
  "arrow-right": [["path", { d: "M5 12h14" }], ["path", { d: "m12 5 7 7-7 7" }]],
  // Collapse/expand-all pair for the Files tree toolbar (mirrored chevrons).
  "chevrons-down-up": [
    ["path", { d: "m7 15 5 5 5-5" }],
    ["path", { d: "m7 9 5-5 5 5" }],
  ],
  "chevrons-up-down": [
    ["path", { d: "m7 9 5-5 5 5" }],
    ["path", { d: "m7 15 5 5 5-5" }],
  ],
  panel: [
    ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }],
    ["line", { x1: 15, y1: 3, x2: 15, y2: 21 }],
  ],
  "panel-left": [
    ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }],
    ["line", { x1: 9, y1: 3, x2: 9, y2: 21 }],
  ],
  square: [["rect", { width: 14, height: 14, x: 5, y: 5, rx: 2 }]],
  copy: [
    ["rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
  ],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  info: [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "M12 16v-4" }],
    ["path", { d: "M12 8h.01" }],
  ],
  "folder-tree": [
    ["path", { d: "M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" }],
    ["path", { d: "M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.9-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" }],
    ["path", { d: "M3 5a2 2 0 0 1 2-2h3" }],
    ["path", { d: "M3 3v13a3 3 0 0 0 3 3h4" }],
  ],
  folder: [
    ["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }],
  ],
  file: [
    ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }],
    ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }],
  ],
  paperclip: [
    ["path", { d: "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" }],
  ],
  // Прогоны субагентов — голова робота: читается как «агенты», а не как
  // аккаунт/мультипользовательский режим (прежний `users`).
  bot: [
    ["path", { d: "M12 8V4H8" }],
    ["rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }],
    ["path", { d: "M2 14h2" }],
    ["path", { d: "M20 14h2" }],
    ["path", { d: "M15 13v2" }],
    ["path", { d: "M9 13v2" }],
  ],
  // MCP-серверы — стойки/хосты.
  server: [
    ["rect", { width: 20, height: 8, x: 2, y: 2, rx: 2, ry: 2 }],
    ["rect", { width: 20, height: 8, x: 2, y: 14, rx: 2, ry: 2 }],
    ["line", { x1: 6, y1: 6, x2: 6.01, y2: 6 }],
    ["line", { x1: 6, y1: 18, x2: 6.01, y2: 18 }],
  ],
  // Лампа — бейдж фактической ступени рассуждений в шапке think-блока.
  bulb: [
    ["path",{d:"M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"}], ["path",{d:"M9 18h6"}], ["path",{d:"M10 22h4"}],
  ],
  // LSP "fix" affordance: a wrench reads as repair, not as another refresh.
  wrench: [
    ["path",{d:"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"}],
  ],
  // Files toolbar: collapse-all shrinks, expand-all grows (distinct glyphs,
  // unlike the mirrored chevrons they replace).
  "minimize-2": [
    ["path",{d:"m14 10 7-7"}], ["path",{d:"M20 10h-6V4"}],
    ["path",{d:"m3 21 7-7"}], ["path",{d:"M4 14h6v6"}],
  ],
  "maximize-2": [
    ["path",{d:"m14 10 7-7"}], ["path",{d:"M20 4h-6v6"}],
    ["path",{d:"m3 21 7-7"}], ["path",{d:"M4 20h6v-6"}],
  ],
};
