import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  safeParseVrsAuthorizeRequest,
  VRS_V9_ONLY_KEYS,
} from "../server/vrs-sasha-contract";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const openApi = parse(readFileSync(resolve(
  repositoryRoot,
  "docs/integration/vrs-express-vrs-ai-bridge-openapi.yaml",
), "utf8")) as any;
const requestMedia = openApi.paths["/vrs/authorize"].post.requestBody.content[
  "application/json"
];

describe("VRS V9 handoff contract", () => {
  it("publishes strict V9 selection and a runtime-valid complete example", () => {
    expect(requestMedia.schema.oneOf).toContainEqual({
      $ref: "#/components/schemas/V9AuthorizeRequest",
    });
    expect(openApi["x-vrs-contract-selection"]).toMatchObject({
      rule: "v9-if-any-v9-only-key-is-present-otherwise-v8-or-v5",
      v9OnlyKeys: [...VRS_V9_ONLY_KEYS],
    });

    const example = {
      ...requestMedia.examples.v9.value,
      callback_url:
        "https://sasha-dev.stage.nextgen.shs.com/sasha/api/vrs/webhook",
    };
    expect(safeParseVrsAuthorizeRequest(example)).toMatchObject({
      success: true,
      version: "v9",
    });
  });

  it("documents the two V9 fields as required and strict", () => {
    const v8 = openApi.components.schemas.V8AuthorizeRequest;
    const v9 = openApi.components.schemas.V9AuthorizeRequest;

    expect(v9.additionalProperties).toBe(false);
    expect(new Set(v9.required)).toEqual(new Set([
      ...v8.required,
      "cta_no",
      "district_number",
    ]));
    expect(Object.keys(v9.properties).sort()).toEqual([
      ...Object.keys(v8.properties),
      "cta_no",
      "district_number",
    ].sort());
    expect(v9.properties.cta_no).toMatchObject({
      type: "string",
      minLength: 1,
      pattern: ".*\\S.*",
      "x-vrs-equals-field": "contract_number",
    });
    expect(v9.properties.cta_no).not.toHaveProperty("maxLength");
    expect(v9.properties.district_number.oneOf).toEqual([
      { type: "string", pattern: "^[0-9]{4}$" },
      { const: "N/A" },
    ]);
  });
});
