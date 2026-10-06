/** Pure display metadata only; original photo paths remain the identity. */
export function parseTicketMediaMetadata(photos?: string | null, photoThumbnails?: string | null) {
  let parsed: any = null;
  try { parsed = photos ? JSON.parse(photos) : null; } catch {}
  const thumbs: Record<string, string> = {};
  try {
    const raw = photoThumbnails ? JSON.parse(photoThumbnails) : null;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") thumbs[key] = value;
      }
    }
  } catch {}
  return { parsed, thumbs };
}

export function preparePriorTicketMedia<T extends {
  id: number;
  createdAt?: string | Date | null;
  photos?: string | null;
  photoThumbnails?: string | null;
  rejectedMedia?: any;
}>(history: T[], selectedId: number | null, selectedCreatedAt?: string | Date | null) {
  const selectedTime = selectedCreatedAt
    ? new Date(selectedCreatedAt).getTime() : Number.POSITIVE_INFINITY;
  return history
    .filter(item => item.id !== selectedId &&
      (item.createdAt ? new Date(item.createdAt).getTime() : 0) < selectedTime)
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
    .map(item => {
      const rejectedUrls = new Set<string>();
      try {
        const raw = item.rejectedMedia
          ? (typeof item.rejectedMedia === "string" ? JSON.parse(item.rejectedMedia) : item.rejectedMedia)
          : null;
        for (const photo of raw?.photos || []) {
          if (typeof photo?.url === "string") rejectedUrls.add(photo.url);
        }
      } catch {}
      return { item, ...parseTicketMediaMetadata(item.photos, item.photoThumbnails), rejectedUrls };
    });
}
