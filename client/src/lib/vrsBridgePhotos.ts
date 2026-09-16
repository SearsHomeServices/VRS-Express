export const BRIDGE_PROXY_PHOTO_PATH =
  /^\/api\/submissions\/[1-9][0-9]*\/vrs-ai-photos\/[0-9]+$/;

export function isBridgeProxyPhotoPath(value: string): boolean {
  return BRIDGE_PROXY_PHOTO_PATH.test(value);
}

// Never use a browser-supplied/stale Bridge source as a fetch target. This
// keeps the session Authorization header confined to our index-only route.
export async function loadBridgeProxyPhoto(
  source: string,
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob> {
  if (!isBridgeProxyPhotoPath(source)) {
    throw new Error("invalid-bridge-photo-path");
  }
  if (!token) throw new Error("not-authenticated");
  const response = await fetchImpl(source, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("photo-unavailable");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("invalid-image");
  return blob;
}