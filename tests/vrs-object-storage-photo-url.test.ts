import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectStorageService } from
  "../server/replit_integrations/object_storage/objectStorage";
import { objectStorageClient } from
  "../server/replit_integrations/object_storage/objectStorage";
import { isReservedBridgeObjectPath } from
  "../server/replit_integrations/object_storage/objectStorage";

const originalPrivateObjectDir = process.env.PRIVATE_OBJECT_DIR;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalPrivateObjectDir === undefined) {
    delete process.env.PRIVATE_OBJECT_DIR;
  } else {
    process.env.PRIVATE_OBJECT_DIR = originalPrivateObjectDir;
  }
});

describe("VRS bridge object-storage photo URLs", () => {
  it("requests a 24-hour direct GET URL for the exact private object path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T17:00:00.000Z"));
    process.env.PRIVATE_OBJECT_DIR = "/vrs-dev-bucket/private";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      signed_url:
        "https://storage.googleapis.com/vrs-dev-bucket/private/uploads/photo-1?signed=1",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new ObjectStorageService();
    await expect(service.getObjectEntityReadURL(
      "/objects/uploads/photo-1",
      24 * 60 * 60,
    )).resolves.toBe(
      "https://storage.googleapis.com/vrs-dev-bucket/private/uploads/photo-1?signed=1",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:1106/object-storage/signed-object-url",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      bucket_name: "vrs-dev-bucket",
      object_name: "private/uploads/photo-1",
      method: "GET",
      expires_at: "2026-08-14T17:00:00.000Z",
    });
  });

  it("rejects the bridge namespace before contacting the signer", async () => {
    process.env.PRIVATE_OBJECT_DIR = "/vrs-dev-bucket/private";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new ObjectStorageService();
    await expect(service.getObjectEntityReadURL(
      "/objects/vrs-bridge-photos/44/0",
    )).rejects.toMatchObject({ name: "ObjectNotFoundError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the reserved namespace before generic object serving", () => {
    expect(isReservedBridgeObjectPath("/objects/vrs-bridge-photos/44/0")).toBe(true);
    expect(isReservedBridgeObjectPath("/objects/uploads/photo-1")).toBe(false);
  });

  it("normalizes a slash-prefixed private bucket exactly once for listing", async () => {
    process.env.PRIVATE_OBJECT_DIR = "/vrs-dev-bucket/private";
    const getFiles = vi.fn(async () => [[], undefined]);
    const bucket = { getFiles } as any;
    const bucketSpy = vi.spyOn(objectStorageClient, "bucket")
      .mockReturnValue(bucket);
    await new ObjectStorageService().listObjectEntityFiles("vrs-bridge-photos/");
    expect(bucketSpy).toHaveBeenCalledWith("vrs-dev-bucket");
    expect(getFiles).toHaveBeenCalledWith({
      prefix: "private/vrs-bridge-photos/",
    });
    bucketSpy.mockRestore();
  });
});
