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
// The feed's update card can be dismissed without hiding the persistent footer
// chip / settings row; `showEmptyFeed()` recreates the card on state ticks, so
// the dismissal must live here, not on the DOM node.
let dismissed = false;

export function setUpdateInfo(v: UpdateInfo | null): void {
  // A (re)discovered update re-arms the card; a dismiss of the same version
  // must survive state ticks.
  if (v && (!info || v.latest !== info.latest)) dismissed = false;
  info = v;
}

export function getUpdateInfo(): UpdateInfo | null {
  return info;
}

/** Hides the feed update card until the next update fact arrives. */
export function dismissUpdate(): void {
  dismissed = true;
}

export function isUpdateDismissed(): boolean {
  return dismissed;
}
