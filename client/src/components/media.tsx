// Authenticated media wrapper components.
//
// These components call useMediaUrl() internally to fetch a scoped,
// short-lived media token from GET /api/media-token before setting the
// src attribute.  This ensures /objects/ URLs are never requested without
// a valid token, and that the full session JWT is never placed in a URL.
//
// Usage:
//   <MediaImage src={objectPath} alt="..." className="..." />
//   <MediaVideo src={objectPath} controls />
//   <MediaAudio src={objectPath} controls />
//   <TechPhotoPreview src={objectPath} localPreview={blobUrl} fallbackText="Photo 1" />
//
// Non-/objects/ URLs pass through unchanged (no token is fetched).
// While the token is loading, src is undefined so no HTTP request fires.

import { useState, useEffect } from "react";
import type { ImgHTMLAttributes, VideoHTMLAttributes, AudioHTMLAttributes } from "react";
import { useMediaUrl } from "@/lib/auth";

type MediaImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  src?: string | null;
};

export function MediaImage({ src, ...props }: MediaImageProps) {
  const tokenizedSrc = useMediaUrl(src);
  // lazy/async defaults: photo grids only fetch images near the viewport
  // and decode off the main thread. Callers can override via props.
  return <img loading="lazy" decoding="async" src={tokenizedSrc || undefined} {...props} />;
}

type MediaVideoProps = VideoHTMLAttributes<HTMLVideoElement> & {
  src?: string | null;
};

export function MediaVideo({ src, ...props }: MediaVideoProps) {
  const tokenizedSrc = useMediaUrl(src);
  return <video src={tokenizedSrc || undefined} {...props} />;
}

type MediaAudioProps = AudioHTMLAttributes<HTMLAudioElement> & {
  src?: string | null;
};

export function MediaAudio({ src, ...props }: MediaAudioProps) {
  const tokenizedSrc = useMediaUrl(src);
  return <audio src={tokenizedSrc || undefined} {...props} />;
}

// Tech photo preview: shows a local blob URL while the file is being uploaded,
// then falls back to the tokenized /objects/ URL once the upload completes.
// If both sources fail, hides the image and shows a text placeholder.
interface TechPhotoPreviewProps extends ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  localPreview?: string | null;
  fallbackText?: string;
}

export function TechPhotoPreview({
  src,
  localPreview,
  fallbackText,
  ...props
}: TechPhotoPreviewProps) {
  const tokenizedSrc = useMediaUrl(src);
  const [failed, setFailed] = useState(false);

  // Reset failed state when the url changes (e.g. a new photo is selected)
  useEffect(() => { setFailed(false); }, [src, localPreview]);

  if (failed) {
    return (
      <span className="text-xs text-muted-foreground">{fallbackText ?? "Photo"}</span>
    );
  }

  return (
    <img
      src={localPreview || tokenizedSrc || undefined}
      {...props}
      onError={(e) => {
        const t = e.currentTarget;
        // If the blob preview failed and we have a tokenized URL, switch to it
        if (localPreview && t.src === localPreview && tokenizedSrc) {
          t.src = tokenizedSrc;
          return;
        }
        // All sources exhausted — show placeholder text
        setFailed(true);
      }}
    />
  );
}
