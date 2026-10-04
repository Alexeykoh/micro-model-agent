// Shared slice types for the frontend state. Server payloads (config, host,
// memory, …) stay opaque here — their precise contract types live on the
// backend and are pulled in `import type` at the points that actually read
// them (see docs/specs/2026-10-04-webui-frontend-ts-design.md).
//
// biome-ignore lint/suspicious/noExplicitAny: opaque JSON payloads, typed at consumers.
export type Dict = Record<string, any>;
