import { describe, expect, it } from "bun:test";
import { ProfileCompressor } from "../../../src/modules/user-profile/compressor";

describe("ProfileCompressor", () => {
  it("should compress profile info to ~500 tokens", () => {
    const compressor = new ProfileCompressor();
    const profileInfo = {
      platform: "linux",
      os: "Linux Ubuntu",
      hostname: "dev-machine",
      shell: "/bin/bash",
      home: "/home/user",
      nodeVersion: "v20.0.0",
      preferences: { editor: "vim", theme: "dark" },
    };

    const compressed = compressor.compress(profileInfo);

    expect(compressed.length).toBeLessThan(2000);
    expect(compressed).toContain("Linux Ubuntu");
    expect(compressed).toContain("/bin/bash");
    expect(compressed).toContain("editor");
  });
});
