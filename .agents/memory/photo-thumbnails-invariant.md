---
name: Photo thumbnails identity invariant
description: Rule for any change touching submission photo grids, rejection, lightbox, or media URLs.
---

The thumbnail map (`submissions.photo_thumbnails`, JSON `{fullPath: thumbPath}`) may ONLY be used to swap the grid `<img>` src.

**Why:** Full photo paths are the identity key across rejection toggles, `rejected_media`, lightbox `buildMediaUrls`, downloads, resubmit carry-forward, and the media-token ownership check. If a thumb path leaks into any of those, rejections stop matching and resubmit hydration breaks silently.

**How to apply:** When editing any photo grid or media flow, keep `togglePhotoRejection(url)`, `openLightbox(buildMediaUrls(...))`, and download handlers on the FULL path; render with `thumbs[url] ?? url`. Missing/junk map must degrade to the full image (empty map), never error. Resubmit filters the map to currently-attached photos at payload time — keep that filter if photo attach/remove logic changes. Thumb values share the same trust bar as `photos` (not ownership-verified at submit); if submit-time ownership verification is ever added, include photoThumbnails.
