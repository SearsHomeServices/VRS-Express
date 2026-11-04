import { describe, expect, it } from "vitest";
import { applySashaRequestEdits } from "../server/vrs-sasha-edit";
import type { VrsStoredAuthorizeRequest } from "../server/vrs-sasha-queue";
import { validV5AuthorizePayload, validV9AuthorizePayload } from "./fixtures/vrs-authorize-payloads";

// What the bridge stores: SASHA's request without the callback secret.
const stored = (base: Record<string, unknown>) => {
  const { callback_secret: _secret, ...rest } = base;
  return structuredClone(rest) as unknown as VrsStoredAuthorizeRequest;
};

describe("SASHA request corrections (trusted as sent; only the agent's changes)", () => {
  it("replaces only the changed fields and leaves everything else exactly as SASHA sent it", () => {
    const original = stored({ ...validV9AuthorizePayload, partner_id: "FA", contract_number: "622900001-3", cta_no: "622900001-3" });
    const snapshot = structuredClone(original);
    const result = applySashaRequestEdits(original, {
      fields: { serial_number: " C31290999 ", brand: "Whirlpool", labor_amount: 135 },
      parts: [{ index: 0, sell_price: 250, part_id: "WPW10503278" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toEqual(["serial_number", "labor_amount", "parts[0].sell_price"]);
    expect(result.payload).toEqual({
      ...snapshot,
      serial_number: "C31290999",
      labor_amount: 135,
      parts: [{ ...snapshot.parts[0], sell_price: 250 }],
    });
    // SASHA's partner, contract number and callback are untouched; the stored row object is not mutated.
    expect(result.payload).toMatchObject({ partner_id: "FA", contract_number: "622900001-3", callback_url: snapshot.callback_url });
    expect(original).toEqual(snapshot);
  });

  it("returns SASHA's request unchanged when nothing differs", () => {
    const original = stored(validV9AuthorizePayload);
    const result = applySashaRequestEdits(original, { fields: { brand: "Whirlpool" }, parts: [{ index: 0, sell_price: 245 }] });
    expect(result).toEqual({ ok: true, payload: original, changed: [] });
  });

  it("never adds a field SASHA did not send, and never touches non-editable fields", () => {
    const v5 = stored(validV5AuthorizePayload);
    expect(applySashaRequestEdits(v5, { fields: { contract_number: "622900001-3" } }))
      .toEqual({ ok: false, error: "contract_number was not in SASHA's request, so it can't be added" });
    for (const name of ["service_order", "tech_id", "partner_id", "callback_url", "appliance_photos"]) {
      expect(applySashaRequestEdits(v5, { fields: { [name]: "x" } })).toMatchObject({ ok: false, error: `${name} can't be changed here` });
    }
    expect(applySashaRequestEdits(v5, { parts: [{ index: 3, sell_price: 1 }] })).toMatchObject({ ok: false });
    expect(applySashaRequestEdits(v5, { parts: [{ index: 0, part_note: "x" }] })).toMatchObject({ ok: false });
  });

  it("rejects bad values and requests VRS AI would refuse", () => {
    const v9 = stored(validV9AuthorizePayload);
    expect(applySashaRequestEdits(v9, { fields: { labor_amount: -1 } })).toMatchObject({ ok: false });
    expect(applySashaRequestEdits(v9, { fields: { labor_amount: "120" } })).toMatchObject({ ok: false });
    expect(applySashaRequestEdits(v9, { fields: { brand: 5 } })).toMatchObject({ ok: false });
    // V9 requires cta_no = contract_number: a cta_no that no longer matches is refused.
    const mismatch = applySashaRequestEdits(stored({ ...validV9AuthorizePayload, cta_no: "999" }), { fields: { brand: "GE" } });
    expect(mismatch).toMatchObject({ ok: false });
    if (!mismatch.ok) expect(mismatch.error).toContain("not valid for VRS AI");
  });

  it("carries a contract number correction to cta_no, the same number", () => {
    const result = applySashaRequestEdits(stored(validV9AuthorizePayload), { fields: { contract_number: "622900001-3" } });
    expect(result).toMatchObject({ ok: true, changed: ["contract_number", "cta_no"] });
    if (result.ok) expect(result.payload).toMatchObject({ contract_number: "622900001-3", cta_no: "622900001-3" });
    expect(applySashaRequestEdits(stored(validV9AuthorizePayload), { fields: { cta_no: "1" } })).toMatchObject({ ok: false });
  });
});
