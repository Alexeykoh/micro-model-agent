// Shared "update available" fact for the `mma web` chrome.
//
// Leaf module (no imports): `app.ts` writes it from the host snapshot, and the
// feed card + settings row read it. Keeping it here avoids any import cycle
// between the app shell and the render modules.

export interface UpdateInfo {
  current: string;
  latest: string;
}

let info: UpdateInfo | null = null;

export function setUpdateInfo(v: UpdateInfo | null): void {
  info = v;
}

export function getUpdateInfo(): UpdateInfo | null {
  return info;
}
