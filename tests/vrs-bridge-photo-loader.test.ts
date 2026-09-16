import { describe, expect, it, vi } from "vitest";
import {
  isBridgeProxyPhotoPath,
  loadBridgeProxyPhoto,
} from "../client/src/lib/vrsBridgePhotos";

describe("Bridge photo browser loader", () => {
  it("only treats canonical index-only same-origin paths as proxy paths", () => {
    expect(isBridgeProxyPhotoPath("/api/submissions/44/vrs-ai-photos/0")).toBe(true);
    expect(isBridgeProxyPhotoPath("/api/submissions/0/vrs-ai-photos/0")).toBe(false);
    expect(isBridgeProxyPhotoPath("/api/submissions/44/vrs-ai-photos/0?url=x")).toBe(false);
    expect(isBridgeProxyPhotoPath("https://attacker.example/photo.jpg")).toBe(false);
  });

  it("never sends the session Authorization header to stale external or malformed sources", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      loadBridgeProxyPhoto("https://attacker.example/photo.jpg", "session-token", fetchImpl),
    ).rejects.toThrow("invalid-bridge-photo-path");
    await expect(
      loadBridgeProxyPhoto("/api/submissions/44/vrs-ai-photos/0?bad=true", "session-token", fetchImpl),
    ).rejects.toThrow("invalid-bridge-photo-path");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("loads an image only through the canonical proxy endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Blob(["image"], { type: "image/jpeg" }), { status: 200 }),
    );
    await expect(
      loadBridgeProxyPhoto("/api/submissions/44/vrs-ai-photos/0", "session-token", fetchImpl),
    ).resolves.toBeInstanceOf(Blob);
    expect(fetchImpl).toHaveBeenCalledWith("/api/submissions/44/vrs-ai-photos/0", {
      headers: { Authorization: "Bearer session-token" },
    });
  });
});