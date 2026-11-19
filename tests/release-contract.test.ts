import { describe, expect, it } from "vitest";
import {
  artifactName,
  artifactUrl,
  manifestUrl,
  MMA_DEFAULT_RELEASE_BASE,
  MMA_REPO,
  releaseBase,
  releasePlatformKey,
} from "../src/modules/updater/release";

describe("release contract", () => {
  it("maps platform/arch to manifest keys", () => {
    expect(releasePlatformKey("win32", "x64")).toBe("win-x64");
    expect(releasePlatformKey("darwin", "arm64")).toBe("mac-arm64");
    expect(releasePlatformKey("darwin", "x64")).toBe("mac-x64");
    expect(releasePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(releasePlatformKey("linux", "arm64")).toBe("linux-arm64");
  });

  it("rejects unsupported platforms/arches", () => {
    expect(releasePlatformKey("freebsd", "x64")).toBeNull();
    expect(releasePlatformKey("linux", "ia32")).toBeNull();
    expect(releasePlatformKey("win32", "ppc64")).toBeNull();
  });

  it("names artifacts versionless (stable latest/download URL)", () => {
    expect(artifactName("win-x64")).toBe("mma-win-x64.tar.gz");
    expect(artifactUrl("linux-arm64")).toBe("mma-linux-arm64.tar.gz");
  });

  it("builds the default manifest URL from GitHub Releases", () => {
    expect(releaseBase({})).toBe(MMA_DEFAULT_RELEASE_BASE);
    expect(MMA_DEFAULT_RELEASE_BASE).toContain(MMA_REPO);
    expect(manifestUrl({})).toBe(`${MMA_DEFAULT_RELEASE_BASE}/latest.json`);
  });

  it("honors MMA_INSTALL_BASE (mirror) and trims trailing slashes", () => {
    expect(releaseBase({ MMA_INSTALL_BASE: "https://mirror.example/mma/" })).toBe(
      "https://mirror.example/mma",
    );
    expect(manifestUrl({ MMA_INSTALL_BASE: "https://mirror.example/mma/" })).toBe(
      "https://mirror.example/mma/latest.json",
    );
  });
});
