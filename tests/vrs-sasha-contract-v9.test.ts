import { describe, expect, it, vi } from "vitest";
import {
  getVrsAuthorizeContractVersion,
  safeParseVrsAuthorizeRequest,
  sendVrsAuthorizeRequest,
  VRS_V9_ONLY_KEYS,
} from "../server/vrs-sasha-contract";
import {
  validV8AuthorizePayload,
  validV9AuthorizePayload,
} from "./fixtures/vrs-authorize-payloads";

const v9OnlyKeys = ["cta_no", "district_number"] as const;

describe("VRS authorize V9 contract", () => {
  it("classifies and accepts the complete strict V9 payload without changing V8", () => {
    expect(VRS_V9_ONLY_KEYS).toEqual(v9OnlyKeys);
    expect(getVrsAuthorizeContractVersion(validV8AuthorizePayload)).toBe("v8");

    const parsed = safeParseVrsAuthorizeRequest(validV9AuthorizePayload);

    expect(parsed.success).toBe(true);
    expect(parsed.version).toBe("v9");
    if (parsed.success) expect(parsed.data).toEqual(validV9AuthorizePayload);
  });

  it.each(v9OnlyKeys)(
    "selects strict V9 when only the %s intent key is present",
    (key) => {
      const parsed = safeParseVrsAuthorizeRequest({
        ...validV8AuthorizePayload,
        [key]: validV9AuthorizePayload[key],
      });

      expect(parsed.success).toBe(false);
      expect(parsed.version).toBe("v9");
    },
  );

  it.each(["cta_no", "district_number"] as const)(
    "requires V9 field %s",
    (key) => {
      const payload: Record<string, unknown> = { ...validV9AuthorizePayload };
      delete payload[key];

      const parsed = safeParseVrsAuthorizeRequest(payload);

      expect(parsed.success).toBe(false);
      expect(parsed.version).toBe("v9");
    },
  );

  it.each([
    ["blank cta_no", { ...validV9AuthorizePayload, cta_no: "" }],
    ["short district", { ...validV9AuthorizePayload, district_number: "206" }],
    ["long district", { ...validV9AuthorizePayload, district_number: "08206" }],
    ["non-numeric district", { ...validV9AuthorizePayload, district_number: "82A6" }],
    [
      "divergent cta and contract numbers",
      { ...validV9AuthorizePayload, cta_no: "9999999999" },
    ],
  ])("rejects %s", (_label, payload) => {
    const parsed = safeParseVrsAuthorizeRequest(payload);

    expect(parsed.success).toBe(false);
    expect(parsed.version).toBe("v9");
  });

  it("accepts explicit V9 unavailable placeholders", () => {
    const payload = {
      ...validV9AuthorizePayload,
      contract_number: "N/A",
      cta_no: "N/A",
      district_number: "N/A",
    };

    expect(safeParseVrsAuthorizeRequest(payload)).toMatchObject({
      success: true,
      version: "v9",
      data: payload,
    });
  });

  it("dispatches V9 with the same business key set and values", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        call_id: "vrs_ai_call_v9",
        service_order: validV9AuthorizePayload.service_order,
        state: "queued",
        created_at: "2026-08-14T18:00:00Z",
      }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(sendVrsAuthorizeRequest({
      baseUrl: "https://vrs-dev.stage.nextgen.shs.com",
      apiKey: "test-api-key",
      callbackUrl:
        "https://vrs-express-dev.example.com/api/integrations/vrs-ai/v1/webhook",
      callbackSecret: "express-callback-secret-at-least-32-characters",
      payload: validV9AuthorizePayload,
      fetchImpl,
    })).resolves.toMatchObject({
      kind: "accepted",
      callId: "vrs_ai_call_v9",
    });

    expect(sentBody).toMatchObject({
      cta_no: "1234567890",
      contract_number: "1234567890",
      district_number: "8206",
    });
    expect(Object.keys(sentBody ?? {}).sort()).toEqual(
      Object.keys(validV9AuthorizePayload).sort(),
    );
  });
});
