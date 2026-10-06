import { describe, expect, it } from "vitest";
import { parseTicketMediaMetadata, preparePriorTicketMedia } from "../client/src/lib/ticket-media-metadata";

describe("ticket display metadata compatibility", () => {
  it.each([undefined, null, "", "{bad"])("preserves empty/malformed media fallback (%s)", value => {
    expect(parseTicketMediaMetadata(value, value)).toEqual({ parsed: null, thumbs: {} });
  });

  it("keeps grouped photos and original identity separate from thumbnail sources", () => {
    const photos = { issue: ["/original/a"], estimate: ["/original/b"] };
    const result = parseTicketMediaMetadata(JSON.stringify(photos), JSON.stringify({
      "/original/a": "/thumb/a", invalid: 3, nested: {},
    }));
    expect(result).toEqual({ parsed: photos, thumbs: { "/original/a": "/thumb/a" } });
    expect(result.parsed.issue).toEqual(["/original/a"]);
  });

  it("preserves legacy arrays and rejects array thumbnail maps", () => {
    expect(parseTicketMediaMetadata('["/original/a"]', '["/thumb/a"]'))
      .toEqual({ parsed: ["/original/a"], thumbs: {} });
  });

  it("preserves JSON primitives rather than changing legacy rendering semantics", () => {
    expect(parseTicketMediaMetadata("false", "null")).toEqual({ parsed: false, thumbs: {} });
  });

  it("excludes selected, equal-time, newer and invalid-date rows; sorts without mutating the input", () => {
    const history = [
      { id: 5, createdAt: "2026-10-05" },
      { id: 2, createdAt: "2026-10-02" },
      { id: 4, createdAt: "2026-10-03" },
      { id: 1, createdAt: "2026-10-01" },
      { id: 3, createdAt: "2026-10-03" },
      { id: 6, createdAt: "invalid" },
    ];
    const original = structuredClone(history);
    expect(preparePriorTicketMedia(history, 3, "2026-10-03").map(row => row.item.id)).toEqual([1, 2]);
    expect(history).toEqual(original);
  });

  it("retains missing-date behavior and handles deselection", () => {
    const history = [{ id: 1 }, { id: 2, createdAt: "2026-10-01" }];
    expect(preparePriorTicketMedia(history, 2).map(row => row.item.id)).toEqual([1]);
    expect(preparePriorTicketMedia([], null)).toEqual([]);
  });

  it.each([true, false])("handles stored rejection metadata as JSON or object (%s)", asString => {
    const rejected = { photos: [{ url: "/original/a" }, { url: 7 }, null] };
    const [row] = preparePriorTicketMedia([{
      id: 1, photos: '["/original/a"]', photoThumbnails: '{"/original/a":"/thumb/a"}',
      rejectedMedia: asString ? JSON.stringify(rejected) : rejected,
    }], 2);
    expect([...row.rejectedUrls]).toEqual(["/original/a"]);
    expect(row.parsed).toEqual(["/original/a"]);
    expect(row.thumbs["/original/a"]).toBe("/thumb/a");
  });

  it("tolerates malformed rejection metadata", () => {
    const [row] = preparePriorTicketMedia([{ id: 1, rejectedMedia: "{bad" }], 2);
    expect(row.rejectedUrls.size).toBe(0);
  });
});
