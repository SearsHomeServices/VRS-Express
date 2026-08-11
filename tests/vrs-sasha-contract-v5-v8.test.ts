import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contractModule from "../server/vrs-sasha-contract";
import {
  signedTinaPhotoUrl,
  validV5AuthorizePayload,
  validV8AuthorizePayload,
} from "./fixtures/vrs-authorize-payloads";

const requiredV8Keys = [
  "appliance_color",
  "contract_number",
  "purchase_year",
  "symptom",
  "appliance_grade",
  "partner_id",
  "appliance_photos",
  "comments",
] as const;

const v8OnlyKeys = [
  "appliance_color",
  "contract_number",
  "purchase_year",
  "symptom",
] as const;

type VersionedParseResult =
  | {
      success: true;
      version: "v5" | "v8";
      data: Record<string, unknown>;
    }
  | {
      success: false;
      version: "v5" | "v8";
      error?: unknown;
    };

const candidateContractModule = contractModule as typeof contractModule & {
  VRS_V8_ONLY_KEYS?: readonly string[];
  getVrsAuthorizeContractVersion?: (input: unknown) => "v5" | "v8";
  safeParseVrsAuthorizeRequest?: (input: unknown) => VersionedParseResult;
};

const safeParseVrsAuthorizeRequest = (input: unknown): VersionedParseResult =>
  candidateContractModule.safeParseVrsAuthorizeRequest?.(input) ?? {
    success: false,
    version: "v5",
  };

const getVrsAuthorizeContractVersion = (input: unknown): "v5" | "v8" =>
  candidateContractModule.getVrsAuthorizeContractVersion?.(input) ?? "v5";

// @ts-expect-error Effects schemas must not advertise object-only mutators.
void contractModule.vrsAuthorizeV5RequestSchema.extend;

describe("VRS authorize V5/V8 contract selection", () => {
  it("exports the V5 validator as its actual effects schema class", () => {
    expect(contractModule.vrsAuthorizeV5RequestSchema).toBeInstanceOf(
      z.ZodEffects,
    );
    expect(contractModule.vrsAuthorizeV5RequestSchema).not.toHaveProperty(
      "extend",
    );
  });

  it("exports the canonical V8 intent keys", () => {
    expect(candidateContractModule.VRS_V8_ONLY_KEYS).toEqual(v8OnlyKeys);
  });

  it("classifies the canonical V5 payload without changing its wire keys", () => {
    const parsed = safeParseVrsAuthorizeRequest(validV5AuthorizePayload);

    expect(parsed.success).toBe(true);
    expect(parsed.version).toBe("v5");
    if (!parsed.success) return;
    expect(parsed.data).toEqual(validV5AuthorizePayload);
    expect(Object.keys(parsed.data)).toEqual(Object.keys(validV5AuthorizePayload));
    expect(parsed.data).not.toHaveProperty("contract_version");
  });

  it("retains the existing V5 trimming behavior", () => {
    const parsed = safeParseVrsAuthorizeRequest({
      ...validV5AuthorizePayload,
      tech_name: "  Carlos Rivera  ",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.tech_name).toBe("Carlos Rivera");
  });

  it("classifies the complete canonical V8 payload", () => {
    const parsed = safeParseVrsAuthorizeRequest(validV8AuthorizePayload);

    expect(parsed.success).toBe(true);
    expect(parsed.version).toBe("v8");
    if (!parsed.success) return;
    expect(parsed.data).toEqual(validV8AuthorizePayload);
    expect(parsed.data).not.toHaveProperty("contract_version");
  });

  it.each(v8OnlyKeys)(
    "selects strict V8 when only the %s V8-intent key is added",
    (key) => {
      const parsed = safeParseVrsAuthorizeRequest({
        ...validV5AuthorizePayload,
        [key]: validV8AuthorizePayload[key],
      });

      expect(getVrsAuthorizeContractVersion({ [key]: "intent" })).toBe("v8");
      expect(parsed.success).toBe(false);
      expect(parsed.version).toBe("v8");
    },
  );

  it("treats a body with no V8-only intent key as V5", () => {
    expect(getVrsAuthorizeContractVersion({
      ...validV5AuthorizePayload,
      appliance_grade: "N/A",
    })).toBe("v5");
  });
});

describe("VRS authorize V8 strict schema", () => {
  it("accepts every documented V8 gap value without mutating it", () => {
    const payload = {
      ...validV8AuthorizePayload,
      tech_phone: "N/A",
      tech_name: "",
      parts: [{
        ...validV8AuthorizePayload.parts[0],
        sell_price: 0,
        part_function: "",
      }],
      customer_name: "",
      appliance_age: 0,
      labor_amount: 0,
      tax_amount: 0,
      part_price: 0,
      appliance_location: "other",
      failure_cause: "other" as const,
      tech_recommendation: "repair" as const,
      repair_replace_rationale: "",
      appliance_color: "N/A",
      contract_number: "N/A",
      purchase_year: "TBD",
      symptom: "N/A",
      appliance_grade: "N/A",
      partner_id: "N/A",
      appliance_photos: [],
      comments: [],
    };

    const parsed = safeParseVrsAuthorizeRequest(payload);

    expect(parsed.success).toBe(true);
    expect(parsed.version).toBe("v8");
    if (!parsed.success) return;
    expect(parsed.data).toEqual(payload);
  });

  it.each(requiredV8Keys)("requires the V8 %s key", (key) => {
    const payload: Record<string, unknown> = { ...validV8AuthorizePayload };
    delete payload[key];

    const parsed = safeParseVrsAuthorizeRequest(payload);

    expect(parsed.success).toBe(false);
    expect(parsed.version).toBe("v8");
  });

  it.each([2022, "TBD", "N/A"])("accepts purchase_year %j", (purchaseYear) => {
    expect(safeParseVrsAuthorizeRequest({
      ...validV8AuthorizePayload,
      purchase_year: purchaseYear,
    }).success).toBe(true);
  });

  it.each([0, -1, 2022.5, "", "2022"])(
    "rejects invalid purchase_year %j",
    (purchaseYear) => {
      const parsed = safeParseVrsAuthorizeRequest({
        ...validV8AuthorizePayload,
        purchase_year: purchaseYear,
      });

      expect(parsed.success).toBe(false);
      expect(parsed.version).toBe("v8");
    },
  );

  it.each([
    ["tech_phone", "TBD"],
    ["appliance_color", ""],
    ["contract_number", ""],
    ["symptom", ""],
    ["appliance_grade", "TBD"],
    ["partner_id", ""],
  ])("rejects invalid %s placeholder %j", (field, value) => {
    const parsed = safeParseVrsAuthorizeRequest({
      ...validV8AuthorizePayload,
      [field]: value,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.version).toBe("v8");
  });

  it.each([
    ["unknown root key", { ...validV8AuthorizePayload, unexpected: true }],
    ["cta_no", { ...validV8AuthorizePayload, cta_no: "CTA-1" }],
    ["V4 end_level alias", { ...validV8AuthorizePayload, end_level: "mid" }],
    ["V4 diagnostic_photos alias", {
      ...validV8AuthorizePayload,
      diagnostic_photos: ["https://example.test/legacy.jpg"],
    }],
    ["unknown part key", {
      ...validV8AuthorizePayload,
      parts: [{ ...validV8AuthorizePayload.parts[0], unexpected: true }],
    }],
    ["unknown comment key", {
      ...validV8AuthorizePayload,
      comments: [{
        ...validV5AuthorizePayload.comments[0],
        unexpected: true,
      }],
    }],
    ["invalid photo URL", {
      ...validV8AuthorizePayload,
      appliance_photos: ["not-a-url"],
    }],
    ["more than ten photos", {
      ...validV8AuthorizePayload,
      appliance_photos: Array.from(
        { length: 11 },
        (_, index) => `https://tina.example.test/photo/${index}`,
      ),
    }],
    ["more than twenty comments", {
      ...validV8AuthorizePayload,
      comments: Array.from(
        { length: 21 },
        () => ({ ...validV5AuthorizePayload.comments[0] }),
      ),
    }],
  ])("rejects %s", (_label, payload) => {
    expect(safeParseVrsAuthorizeRequest(payload).success).toBe(false);
  });

  it("preserves signed TINA URL bytes and surrounding business whitespace", () => {
    const payload = {
      ...validV8AuthorizePayload,
      tech_name: "  Carlos Rivera  ",
      customer_name: "  Maria Gonzalez  ",
      contract_number: "  1234567890  ",
      symptom: "  Washer not draining  ",
      appliance_photos: [signedTinaPhotoUrl],
      parts: [{
        ...validV8AuthorizePayload.parts[0],
        part_function: "  Controls wash cycle timing.  ",
      }],
    };

    const parsed = safeParseVrsAuthorizeRequest(payload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(payload);
    expect(parsed.data.appliance_photos).toEqual([signedTinaPhotoUrl]);
  });

  it("does not invent maxima for contract_number or symptom", () => {
    const payload = {
      ...validV8AuthorizePayload,
      contract_number: "C".repeat(101),
      symptom: "S".repeat(2_001),
    };

    const parsed = safeParseVrsAuthorizeRequest(payload);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.contract_number).toBe(payload.contract_number);
    expect(parsed.data.symptom).toBe(payload.symptom);
  });
});

describe("VRS authorize outbound source validation", () => {
  it("accepts V8 and preserves its exact business key set for dispatch", async () => {
    let sentBody: Record<string, unknown> | undefined;

    const result = await contractModule.sendVrsAuthorizeRequest({
      baseUrl: "https://vrs-ai.example.test",
      apiKey: "vrs-ai-test-key",
      callbackUrl:
        "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "express-to-vrs-ai-test-secret",
      payload: validV8AuthorizePayload,
      fetchImpl: async (_input, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          call_id: "vrs_ai_call_123",
          state: "queued",
        }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(result.kind).toBe("accepted");
    expect(Object.keys(sentBody ?? {})).toEqual(Object.keys(validV8AuthorizePayload));
    expect(sentBody?.appliance_photos).toEqual([signedTinaPhotoUrl]);
    expect(sentBody).not.toHaveProperty("contract_version");
  });

  it("rejects a source callback URL with query parameters", async () => {
    await expect(contractModule.sendVrsAuthorizeRequest({
      baseUrl: "https://vrs-ai.example.test",
      apiKey: "vrs-ai-test-key",
      callbackUrl:
        "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "express-to-vrs-ai-test-secret",
      payload: {
        ...validV8AuthorizePayload,
        callback_url:
          "https://vrs-express.example.test/api/integrations/vrs-ai/v1/webhook?redirect=1",
      },
      fetchImpl: async () => new Response(JSON.stringify({
        call_id: "unexpected",
        state: "queued",
      }), { status: 202 }),
    })).rejects.toThrow("callback_url must be a clean HTTPS URL");
  });
});
