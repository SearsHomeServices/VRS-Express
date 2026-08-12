import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  VRS_V8_ONLY_KEYS,
  safeParseVrsAuthorizeRequest,
  vrsWebhookEventSchema,
} from "../server/vrs-sasha-contract";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const architecturePath = resolve(
  repositoryRoot,
  "docs/architecture/vrs-sasha-api-v5.md",
);
const handoffPath = resolve(
  repositoryRoot,
  "docs/integration/vrs-express-vrs-ai-bridge-handoff.md",
);
const openApiPath = resolve(
  repositoryRoot,
  "docs/integration/vrs-express-vrs-ai-bridge-openapi.yaml",
);

const architecture = readFileSync(architecturePath, "utf8");
const handoff = readFileSync(handoffPath, "utf8");
const openApiSource = readFileSync(openApiPath, "utf8");
const openApi = parse(openApiSource) as any;

const requestMedia = openApi.paths?.["/vrs/authorize"]?.post?.requestBody
  ?.content?.["application/json"];
const callbackPost = openApi.paths?.["/vrs/authorize"]?.post?.callbacks
  ?.vrsAiResult?.["{$request.body#/callback_url}"]?.post;

const v8AlwaysPresent = [
  "service_order",
  "tech_id",
  "tech_phone",
  "tech_name",
  "reason_for_call",
  "callback_url",
  "callback_secret",
  "parts",
  "customer_name",
  "customer_address",
  "service_address",
  "brand",
  "model_number",
  "serial_number",
  "appliance_type",
  "appliance_age",
  "labor_amount",
  "tax_amount",
  "part_price",
  "appliance_location",
  "failure_cause",
  "tech_recommendation",
  "repair_replace_rationale",
  "appliance_grade",
  "partner_id",
  "appliance_photos",
  "comments",
  "appliance_color",
  "contract_number",
  "purchase_year",
  "symptom",
] as const;

const allowedPlaceholders = [
  "<UPSTREAM_DEV_CALLBACK_URL>",
  "<VRS_AI_DEV_BASE_URL>",
  "<VRS_EXPRESS_DEV_BASE_URL>",
  "<VRS_EXPRESS_DEV_CALLBACK_URL>",
] as const;

function resolveLocalRef(root: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) return undefined;

  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((value, part) => {
      if (typeof value !== "object" || value === null) return undefined;
      return (value as Record<string, unknown>)[part];
    }, root);
}

function collectLocalRefs(value: unknown, references: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectLocalRefs(item, references);
    return references;
  }
  if (typeof value !== "object" || value === null) return references;

  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && typeof item === "string" && item.startsWith("#/")) {
      references.push(item);
    } else {
      collectLocalRefs(item, references);
    }
  }
  return references;
}

function authorizeExample(name: "v5" | "v8"): Record<string, unknown> {
  return structuredClone(requestMedia.examples[name].value);
}

function runtimeAuthorizeExample(name: "v5" | "v8"): Record<string, unknown> {
  return {
    ...authorizeExample(name),
    callback_url:
      "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
  };
}

describe("VRS bridge OpenAPI contract", () => {
  it("parses as OpenAPI 3.1 and resolves every local reference", () => {
    expect(openApi.openapi).toMatch(/^3\.1\./);

    const references = collectLocalRefs(openApi);
    expect(references.length).toBeGreaterThan(20);
    for (const reference of references) {
      expect(resolveLocalRef(openApi, reference), reference).toBeDefined();
    }
  });

  it("selects one strict V5 or V8 request without a wire version field", () => {
    expect(requestMedia.schema).toEqual({
      oneOf: [
        { $ref: "#/components/schemas/V5AuthorizeRequest" },
        { $ref: "#/components/schemas/V8AuthorizeRequest" },
      ],
    });

    const selection = openApi["x-vrs-contract-selection"];
    expect(selection).toEqual({
      rule: "v8-if-any-v8-only-key-is-present-otherwise-v5",
      v8OnlyKeys: [...VRS_V8_ONLY_KEYS],
      forbiddenVersionFields: ["contractVersion", "contract_version"],
    });

    for (const version of ["V5", "V8"] as const) {
      const schema = openApi.components.schemas[`${version}AuthorizeRequest`];
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties).not.toHaveProperty("contractVersion");
      expect(schema.properties).not.toHaveProperty("contract_version");
      expect(schema.properties).not.toHaveProperty("cta_no");
      expect(schema.properties).not.toHaveProperty("end_level");
      expect(schema.properties).not.toHaveProperty("diagnostic_photos");
    }
  });

  it("keeps the complete V5 and V8 examples aligned with runtime parsing", () => {
    expect(Object.keys(requestMedia.examples).sort()).toEqual(["v5", "v8"]);

    const v5 = authorizeExample("v5");
    const parsedV5 = safeParseVrsAuthorizeRequest(runtimeAuthorizeExample("v5"));
    expect(parsedV5.success).toBe(true);
    expect(parsedV5.version).toBe("v5");
    expect(VRS_V8_ONLY_KEYS.some((key) => key in v5)).toBe(false);

    const v8 = authorizeExample("v8");
    const parsedV8 = safeParseVrsAuthorizeRequest(runtimeAuthorizeExample("v8"));
    expect(parsedV8.success).toBe(true);
    expect(parsedV8.version).toBe("v8");
    expect(v8AlwaysPresent.every((key) => key in v8)).toBe(true);

    const partialV8 = { ...runtimeAuthorizeExample("v5"), symptom: "N/A" };
    const parsedPartial = safeParseVrsAuthorizeRequest(partialV8);
    expect(parsedPartial.success).toBe(false);
    expect(parsedPartial.version).toBe("v8");
  });

  it("publishes the exact runtime request constraints without invented maxima", () => {
    const schemas = openApi.components.schemas;
    const v5 = schemas.V5AuthorizeRequest;
    const v8 = schemas.V8AuthorizeRequest;
    const v5Required = new Set<string>(v5.required);

    expect(new Set(v8.required)).toEqual(new Set(v8AlwaysPresent));
    expect(Object.keys(v8.properties).sort()).toEqual([...v8AlwaysPresent].sort());
    for (const optionalV5Key of [
      "appliance_grade",
      "partner_id",
      "appliance_photos",
      "comments",
    ]) {
      expect(v5Required.has(optionalV5Key)).toBe(false);
      expect(v5.properties).toHaveProperty(optionalV5Key);
    }

    expect(v5.properties.service_order.pattern).toBe("^[0-9]{8}$");
    expect(v8.properties.service_order.pattern).toBe("^[0-9]{8}$");
    expect(v8.properties.tech_id.maxLength).toBe(50);
    expect(v8.properties.tech_name.maxLength).toBe(255);
    expect(v8.properties.callback_secret).toMatchObject({
      minLength: 16,
      maxLength: 512,
    });
    expect(v8.properties.parts).toMatchObject({ minItems: 1 });
    expect(v8.properties.parts).not.toHaveProperty("maxItems");
    expect(v8.properties.appliance_photos.maxItems).toBe(10);
    expect(v8.properties.comments.maxItems).toBe(20);
    expect(v8.properties.appliance_color.maxLength).toBe(40);
    expect(v8.properties.contract_number).not.toHaveProperty("maxLength");
    expect(v8.properties.symptom).not.toHaveProperty("maxLength");
    expect(v8.properties.repair_replace_rationale).not.toHaveProperty(
      "maxLength",
    );
    expect(v8.properties.purchase_year.oneOf[0]).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(v8.properties.purchase_year.oneOf[0]).not.toHaveProperty("maximum");

    for (const emptyAllowed of [
      "tech_name",
      "customer_name",
      "repair_replace_rationale",
    ]) {
      expect(v8.properties[emptyAllowed]).not.toHaveProperty("minLength");
    }

    expect(schemas.V5Part.properties).toMatchObject({
      part_id: { maxLength: 100 },
      part_description: { maxLength: 500 },
      part_function: { maxLength: 200 },
    });
    expect(schemas.V8Part.properties.part_function).not.toHaveProperty(
      "minLength",
    );
    expect(schemas.Comment.properties).toMatchObject({
      tech_id: { maxLength: 50 },
      text: { maxLength: 2000 },
    });
    expect(schemas.Money).toMatchObject({
      minimum: 0,
      maximum: 1_000_000,
      multipleOf: 0.01,
    });
    expect(schemas.EventEnvelope.properties).toMatchObject({
      eventId: { maxLength: 100 },
      callId: { maxLength: 100 },
    });
    expect(schemas.ApprovedEvent.allOf[1].properties.authNumber.maxLength).toBe(100);
    expect(schemas.PartialEvent.allOf[1].properties.denyReason.maxLength).toBe(2000);
    expect(schemas.DeniedEvent.allOf[1].properties.denyReason.maxLength).toBe(2000);
    expect(schemas.RequiresInfoEvent.allOf[1].properties).toMatchObject({
      question: { maxLength: 2000 },
      field: { maxLength: 100 },
    });
  });

  it("validates all five callback examples with the runtime event schema", () => {
    const examples = callbackPost.requestBody.content["application/json"].examples;
    expect(Object.keys(examples).sort()).toEqual([
      "approved",
      "denied",
      "failed",
      "partial",
      "requiresInfo",
    ]);

    for (const [name, example] of Object.entries(examples) as [
      string,
      { value: unknown },
    ][]) {
      const parsed = vrsWebhookEventSchema.safeParse(example.value);
      expect(parsed.success, `${name} callback example`).toBe(true);
    }

    expect(callbackPost.parameters.map((parameter: any) => parameter.name)).toEqual([
      "X-VRS-Signature",
      "X-VRS-Event-Id",
      "X-VRS-Timestamp",
    ]);
  });

  it("keeps the deterministic raw-byte HMAC vector executable", () => {
    const vector = openApi["x-vrs-hmac-test-vector"];
    const signature = `sha256=${createHmac("sha256", vector.secret)
      .update(Buffer.from(vector.rawBody, "utf8"))
      .digest("hex")}`;

    expect(signature).toBe(vector.expectedSignature);
    expect(vector.rawBody).toBe(JSON.stringify(JSON.parse(vector.rawBody)));
    expect(handoff).toContain(`Secret: ${vector.secret}`);
    expect(handoff).toContain(`Raw body: ${vector.rawBody}`);
    expect(handoff).toContain(`Expected: ${vector.expectedSignature}`);
  });

  it("publishes the real intake rejection and callback retry contracts", () => {
    const authorizeResponses = openApi.paths["/vrs/authorize"].post.responses;
    const callbackResponses = callbackPost.responses;

    expect(authorizeResponses["409"].content["application/json"].schema).toEqual({
      oneOf: [
        { $ref: "#/components/schemas/DuplicateCall" },
        { $ref: "#/components/schemas/IntakeRejection" },
      ],
    });
    expect(authorizeResponses["422"].content["application/json"].schema).toEqual({
      oneOf: [
        { $ref: "#/components/schemas/UnsupportedPartner" },
        { $ref: "#/components/schemas/IntakeRejection" },
      ],
    });
    expect(openApi.components.schemas.IntakeRejection).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["error", "message"],
      properties: {
        error: { type: "string" },
        message: { type: "string" },
      },
    });
    for (const code of [
      "NOT_A_TECHNICIAN",
      "SUBMISSION_ALREADY_EXISTS",
      "SUBMISSION_REJECTED",
    ]) {
      expect(authorizeResponses["409"].description).toContain(code);
      expect(handoff).toContain(`\`${code}\``);
    }
    for (const code of [
      "UNKNOWN_TECHNICIAN",
      "INACTIVE_TECHNICIAN",
      "INVALID_TECHNICIAN_DISTRICT",
      "SUBMISSION_REJECTED",
    ]) {
      expect(authorizeResponses["422"].description).toContain(code);
      expect(handoff).toContain(`\`${code}\``);
    }
    expect(callbackPost["x-vrs-retry-policy"]).toEqual({
      retryableStatusCodes: [500, 502, 503],
      retryNetworkFailures: true,
      maxAttempts: 5,
      backoffSeconds: [1, 2, 4, 8],
      stableEventIdAndBody: true,
    });
    for (const status of ["500", "502", "503"]) {
      expect(callbackResponses).toHaveProperty(status);
      expect(callbackResponses[status].description).toMatch(/retry/i);
    }

    expect(handoff).toMatch(/`422`.*unsupported partner/is);
    expect(handoff).toMatch(/network\s+failures.*`500`.*`502`.*`503`/is);
    expect(handoff).toMatch(/maximum of five attempts/is);
    expect(handoff).toMatch(/1, 2, 4, and 8\s+seconds/is);
  });

  it("marks sample identifiers as replace-before-test DEV prerequisites", () => {
    for (const version of ["v5", "v8"] as const) {
      const example = authorizeExample(version);
      expect(example.tech_id).toBe("replace-with-dev-tech-id");
      expect(example.service_order).toMatch(/^\d{8}$/);
      expect((example.comments as any[])[0].tech_id).toBe(example.tech_id);
    }

    expect(handoff).toMatch(/provisioned active VRS Express DEV technician/is);
    expect(handoff).toMatch(/valid four-digit district/is);
    expect(handoff).toMatch(/replace.*service_order.*unique.*eight-digit/is);
    expect(handoff).toMatch(/prerequisite.*before.*Direction A/is);
  });

  it("publishes the exact callback ticket and technician-SMS effects", () => {
    expect(callbackPost["x-vrs-event-effects"]).toEqual({
      approved: { ticketAction: "approve", technicianSms: true },
      partial: { ticketAction: "approve", technicianSms: true },
      denied: { ticketAction: "reject", technicianSms: true },
      failed: { ticketAction: "status_only", technicianSms: false },
      requires_info: { ticketAction: "status_only", technicianSms: false },
    });

    expect(handoff).toMatch(/\| `approved` \| Approve.*\| Yes/is);
    expect(handoff).toMatch(/\| `partial` \| Approve.*\| Yes/is);
    expect(handoff).toMatch(/\| `denied` \| Reject.*\| Yes/is);
    expect(handoff).toMatch(/\| `failed` \| Status-only.*\| No/is);
    expect(handoff).toMatch(/\| `requires_info` \| Status-only.*\| No/is);
  });

  it("annotates callback_url with the exact directional URL restrictions", () => {
    for (const version of ["V5", "V8"] as const) {
      const callbackUrl = openApi.components.schemas[`${version}AuthorizeRequest`]
        .properties.callback_url;
      expect(callbackUrl).toMatchObject({ type: "string", format: "uri" });
      expect(callbackUrl.description).toMatch(/inbound.*allowlisted clean HTTPS/is);
      expect(callbackUrl.description).toContain(
        "/api/integrations/vrs-ai/v1/webhook",
      );
      expect(callbackUrl.description).toMatch(/replaces.*dispatch/is);
    }
  });
});

describe("VRS bridge platform handoff", () => {
  it("keeps the copyable Markdown payloads identical to the validated OpenAPI examples", () => {
    const jsonBlocks = [...handoff.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)]
      .map((match) => JSON.parse(match[1]) as Record<string, unknown>);
    const authorizeBlocks = jsonBlocks.filter((value) => "callback_url" in value);
    const eventBlocks = jsonBlocks.filter(
      (value) => value.version === 1 && typeof value.eventId === "string",
    );
    const openApiEvents = Object.values(
      callbackPost.requestBody.content["application/json"].examples,
    ).map((example: any) => example.value);

    expect(authorizeBlocks).toEqual([
      authorizeExample("v5"),
      authorizeExample("v8"),
    ]);
    expect(eventBlocks).toEqual(openApiEvents);
  });

  it("uses only the approved development URL placeholders and no live URLs", () => {
    const combined = [architecture, handoff, openApiSource].join("\n");
    const placeholders = [...combined.matchAll(/<[^>\r\n]+>/g)].map(
      (match) => match[0],
    );

    expect(new Set(placeholders)).toEqual(new Set(allowedPlaceholders));
    expect(combined).not.toMatch(/https?:\/\//i);
  });

  it("contains no individual names, source provenance, or credential material", () => {
    const combined = [architecture, handoff, openApiSource].join("\n");

    for (const forbidden of [
      /\bEnzo\b/i,
      /\bTyler\b/i,
      /\bMorgan\b/i,
      /\bLuis\b/i,
      /\bCarlos\b/i,
      /\bMaria\b/i,
      /\bNilikh\b/i,
      /\bSASHA\b/i,
      /\bTech Hub\b/i,
      /\bGranola\b/i,
      /\bmeeting\b/i,
      /\bGitHub\b/i,
      /\bReplit\b/i,
      /\brepository\b/i,
      /\bcommit\b/i,
      /\bpull request\b/i,
      /postgres(?:ql)?:\/\//i,
      /\bsk-[A-Za-z0-9_-]{12,}\b/,
      /\bAKIA[A-Z0-9]{16}\b/,
      /\bAIza[A-Za-z0-9_-]{20,}\b/,
    ]) {
      expect(combined, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("documents the exact two-direction DEV approval boundary", () => {
    expect(handoff).toContain(
      "<VRS_EXPRESS_DEV_BASE_URL>/vrs/authorize",
    );
    expect(handoff).toContain("<VRS_AI_DEV_BASE_URL>/vrs/authorize");
    expect(handoff).toContain("<UPSTREAM_DEV_CALLBACK_URL>");
    expect(handoff).toContain("<VRS_EXPRESS_DEV_CALLBACK_URL>");
    expect(handoff).toMatch(/separate.*X-API-Key/is);
    expect(handoff).toMatch(/same contract version/is);
    expect(handoff).toMatch(/202.*pending human review.*does not call VRS AI/is);
    expect(handoff).toMatch(/VRS AI.*202.*asynchronous admission/is);
    expect(handoff).not.toMatch(/202[^.\n]*(?:call|dial)(?:ing)? (?:has )?started/i);
  });

  it("documents strict selection, URL pass-through, durable dedupe, and V8-only rearm", () => {
    const combined = `${architecture}\n${handoff}`;

    for (const key of VRS_V8_ONLY_KEYS) expect(combined).toContain(`\`${key}\``);
    expect(combined).toMatch(/any one.*strict V8/is);
    expect(combined).toMatch(/partial V8.*(?:reject|fail)/is);
    expect(combined).toMatch(/never.*contractVersion.*contract_version/is);
    expect(combined).toMatch(/TINA.*byte-for-byte/is);
    expect(combined).toContain("`/objects/`");
    expect(combined).toMatch(/durable.*event ledger/is);
    expect(combined).not.toMatch(/(?:24\s*hours?|24h).*(?:dedup|expir)/i);
    expect(combined).toMatch(/V8.*new incoming.*new public call ID.*same ticket/is);
    expect(combined).toMatch(/V5.*does not rearm/is);
    expect(combined).toMatch(/rate limits.*VRS AI/is);
  });
});
