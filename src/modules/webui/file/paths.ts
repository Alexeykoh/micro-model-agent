// Резолвер путей вынесен в нейтральный runtime-слой (его использует и service).
export {
  escapes,
  resolveWorkspacePath,
  type PathErrorCode,
  type PathResolution,
} from "../../../runtime/workspace-fs";
