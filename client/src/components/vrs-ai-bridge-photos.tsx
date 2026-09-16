import React, { useEffect, useMemo, useState } from "react";
import PhotoLightbox from "@/components/photo-lightbox";
import { getToken } from "@/lib/auth";
import {
  isBridgeProxyPhotoPath,
  loadBridgeProxyPhoto,
} from "@/lib/vrsBridgePhotos";

type LoadedPhoto = {
  source: string;
  objectUrl: string;
};

export function VrsAiBridgePhotos({
  photos,
  proxyEnabled,
}: {
  photos: string[];
  proxyEnabled: boolean;
}) {
  const usesProxy = proxyEnabled || photos.some(isBridgeProxyPhotoPath);
  const [loadedPhotos, setLoadedPhotos] = useState<LoadedPhoto[]>([]);
  const [failedSources, setFailedSources] = useState<Set<string>>(new Set());
  const [retryVersion, setRetryVersion] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    if (!usesProxy) return;
    let cancelled = false;
    const createdUrls: string[] = [];

    setLoadedPhotos([]);
    setFailedSources(new Set());
    Promise.all(
      photos.map(async (source) => {
        try {
          const blob = await loadBridgeProxyPhoto(source, getToken());
          const objectUrl = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(objectUrl);
            return null;
          }
          createdUrls.push(objectUrl);
          return { source, objectUrl };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      // A single expired image does not hide photos that are still available.
      // This error UI deliberately never echoes a server response or source URL.
      setLoadedPhotos(
        results.filter((result): result is LoadedPhoto => result !== null),
      );
      setFailedSources(
        new Set(
          photos.filter(
            (source) => !results.some((result) => result?.source === source),
          ),
        ),
      );
    });

    return () => {
      cancelled = true;
      for (const objectUrl of createdUrls) URL.revokeObjectURL(objectUrl);
    };
  }, [photos, retryVersion, usesProxy]);

  const visiblePhotos = useMemo(
    () =>
      usesProxy
        ? loadedPhotos.filter((photo) => !failedSources.has(photo.source))
        : photos.map((source) => ({ source, objectUrl: source })),
    [failedSources, loadedPhotos, photos, usesProxy],
  );

  if (!usesProxy) {
    // Flag-off behavior intentionally retains the original direct-link UI.
    return (
      <div>
        <span className="text-muted-foreground">Sender photos</span>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {photos.map((photo, index) => (
            <a
              key={`${photo}-${index}`}
              href={photo}
              target="_blank"
              rel="noreferrer noopener"
              className="block overflow-hidden rounded-md border bg-background"
            >
              <img
                src={photo}
                referrerPolicy="no-referrer"
                alt={`Sender appliance ${index + 1}`}
                className="h-36 w-full object-cover"
              />
            </a>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <span className="text-muted-foreground">Sender photos</span>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {visiblePhotos.map((photo) => {
          const originalIndex = photos.indexOf(photo.source);
          return (
            <button
              key={photo.source}
              type="button"
              onClick={() => {
                setLightboxIndex(visiblePhotos.indexOf(photo));
                setLightboxOpen(true);
              }}
              className="block overflow-hidden rounded-md border bg-background text-left"
              aria-label={`Open sender appliance ${originalIndex + 1}`}
            >
              <img
                src={photo.objectUrl}
                alt={`Sender appliance ${originalIndex + 1}`}
                className="h-36 w-full object-cover"
                onError={() =>
                  setFailedSources((failed) => new Set(failed).add(photo.source))
                }
              />
            </button>
          );
        })}
        {failedSources.size > 0 && (
          <div
            className="rounded-md border border-destructive/40 p-3 text-destructive"
            role="alert"
            data-testid="vrs-bridge-photo-error"
          >
            One or more sender photos are unavailable.
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => setRetryVersion((version) => version + 1)}
            >
              Retry
            </button>
          </div>
        )}
      </div>
      <PhotoLightbox
        photos={visiblePhotos.map((photo) => photo.objectUrl)}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </div>
  );
}