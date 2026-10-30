// Repair / replace calculator (shared/repair-replace.ts), its service-order
// prefill (server/repair-replace-prefill.ts, snowflake-lookup.ts) and its
// endpoints (server/repair-replace-api.ts). The engine cases are the golden
// tests of the ai-agent-vrs Python package it was ported from
// (tests/repair_replace/test_calculator.py, test_prefill.py); a random
// 5,400-case comparison against that package matched exactly on 2026-10-28.
// Hermetic: Snowflake, storage and auth are doubles.
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ILLUSTRATIVE_POLICY,
  evaluateFrc,
  evaluateLegacy,
  rrSummaryText,
  type RrInput,
} from "../shared/repair-replace";
import {
  buildRepairReplacePrefill,
  loadRepairReplacePrefill,
  RR_AUTHORITATIVE_FIELDS,
  type RepairReplaceTicketInput,
} from "../server/repair-replace-prefill";
import {
  REPAIR_REPLACE_HISTORY_SQL,
  REPAIR_REPLACE_ORDER_SQL,
  REPAIR_REPLACE_PARTS_SQL,
  REPAIR_REPLACE_TECHHUB_SQL,
  createRepairReplaceLookup,
  type AhsPrefillQuery,
} from "../server/services/snowflake-lookup";
import { registerRepairReplaceApi, type RepairReplaceApiDeps } from "../server/repair-replace-api";
import type { HssomRepairFacts } from "../server/services/hssom-order-lookup";

afterEach(() => {
  vi.restoreAllMocks();
});

function quietLogs() {
  return (["log", "info", "warn", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
}

function complete(overrides: Partial<RrInput> = {}): RrInput {
  return {
    parts_cost: "50.00",
    labor_cost: "50.00",
    trip_cost: "50.00",
    appliance_type: "refrigerator",
    age_years: "2",
    replacement_cost: "1000.00",
    visit_number: 1,
    unresolved: false,
    failed_attempt_count: 0,
    other_service_orders_12mo: 0,
    same_part_or_system_repeat: false,
    technician_confident: true,
    component: "door gasket",
    parts_available: true,
    backorder_days: 0,
    contract_spend: "0.00",
    ...overrides,
  };
}

function washerExample(overrides: Partial<RrInput> = {}): RrInput {
  return complete({
    parts_cost: "260.00", labor_cost: "0.00", trip_cost: "125.00", appliance_type: "washer", age_years: "10",
    replacement_cost: "850.00", visit_number: 3, unresolved: true, failed_attempt_count: 2,
    repeat_probability_override: "0.80", ...overrides,
  });
}

const stop = (result: ReturnType<typeof evaluateFrc>, rule: string) =>
  result.hard_stops.find((item) => item.rule === rule)?.status;

describe("Forward Repair Cost", () => {
  it("is explicitly illustrative and never authorizes a replacement", () => {
    const result = evaluateFrc(complete());
    expect(result.policy_version).toBe("illustrative-v1");
    expect(result.policy_status).toBe("illustrative");
    expect(result.authorizes_replacement).toBe(false);
    expect(ILLUSTRATIVE_POLICY.status).toBe("illustrative");
  });

  it("continues a complete young unit", () => {
    const result = evaluateFrc(complete());
    expect(result.route).toBe("continue_authorization");
    expect(result.economic_outcome).toBe("repair");
    expect(result.costs).toMatchObject({ current_repair: "150.00", expected_future: "56.25", forward_repair: "206.25" });
    expect(result.probability?.band).toBe("under_50");
    expect(result.review_required).toBe(false);
  });

  it("reads display names onto the same lives", () => {
    const washer = evaluateFrc(complete({ appliance_type: "Washing machine", age_years: "11" }));
    const stove = evaluateFrc(complete({ appliance_type: "Stove/oven", age_years: "15" }));
    expect(washer.probability).toMatchObject({ expected_life_years: "11", life_used: "1.000000" });
    expect(stove.probability).toMatchObject({ expected_life_years: "15", life_used: "1.000000" });
  });

  it("treats missing history as missing, never zero", () => {
    const result = evaluateFrc(complete({ failed_attempt_count: null, other_service_orders_12mo: null }));
    expect(result.route).toBe("manual_review_incomplete");
    expect(result.missing_inputs).toEqual(expect.arrayContaining(["failed_attempt_count", "other_service_orders_12mo"]));
    expect(result.economic_outcome).not.toBe("repair");
    expect(stop(result, "service_orders_12_months")).toBe("unknown");
  });

  it("is incomplete without a trip charge when no hard stop fires", () => {
    const result = evaluateFrc(complete({ trip_cost: undefined }));
    expect(result.route).toBe("manual_review_incomplete");
    expect(result.missing_inputs).toContain("trip_cost");
  });

  it("caps the probability at 95% and compounds failed attempts at x1.5 (not the example's x1.6)", () => {
    const capped = evaluateFrc(complete({
      appliance_type: "washer", age_years: "10", failed_attempt_count: 4, other_service_orders_12mo: 2,
      same_part_or_system_repeat: true, technician_confident: false,
    }));
    expect(capped.probability?.capped).toBe("0.950000");
    expect(Number(capped.probability?.raw)).toBeGreaterThan(0.95);

    const compounded = evaluateFrc(complete({ appliance_type: "washer", age_years: "10", failed_attempt_count: 2 }));
    expect(compounded.probability).toMatchObject({ base: "0.50", raw: "1.125000" });
    expect(compounded.factors.find((item) => item.name === "failed_attempts")?.factor).toBe("2.25");
  });

  it("prices the leadership washer example with its stated probability", () => {
    const result = evaluateFrc(washerExample());
    expect(result.costs).toMatchObject({
      current_repair: "385.00", expected_future: "300.00", forward_repair: "685.00",
      threshold_amount: "595.00", frc_ratio: "0.805882",
    });
    expect(result.economic_outcome).toBe("replace");
    expect(result.route).toBe("replacement_review");
    expect(stop(result, "third_unresolved_trip")).toBe("fired");
    expect(result.warnings.some((warning) => warning.includes("×1.6"))).toBe(true);
    // Visit 2 of the same example is not a third unresolved trip; same price.
    const second = evaluateFrc(washerExample({ visit_number: 2 }));
    expect(stop(second, "third_unresolved_trip")).toBe("not_fired");
    expect(second.costs.forward_repair).toBe(result.costs.forward_repair);
  });

  it("routes threshold equality to review", () => {
    const result = evaluateFrc(complete({
      parts_cost: "70.00", labor_cost: "0.00", trip_cost: "0.00", replacement_cost: "100.00", repeat_probability_override: "0",
    }));
    expect(result.costs).toMatchObject({ forward_repair: "70.00", threshold_amount: "70.00" });
    expect(result.route).toBe("replacement_review");
  });

  it("fires each hard stop, on the stated boundaries", () => {
    const cases: Array<[string, RrInput]> = [
      ["third_unresolved_trip", complete({ visit_number: 3, unresolved: true })],
      ["service_orders_12_months", complete({ other_service_orders_12mo: 2 })],
      ["major_component_age", complete({ component: "compressor", age_years: "9" })],
      ["parts_unavailable_or_backordered", complete({ parts_available: false })],
      ["contract_spend", complete({ contract_spend: "800.00" })],
    ];
    for (const [rule, input] of cases) {
      const result = evaluateFrc(input);
      expect(stop(result, rule), rule).toBe("fired");
      expect(result.route, rule).toBe("replacement_review");
      expect(result.authorizes_replacement).toBe(false);
    }
    expect(stop(evaluateFrc(complete({ backorder_days: 15 })), "parts_unavailable_or_backordered")).toBe("fired");
    expect(stop(evaluateFrc(complete({ backorder_days: 14 })), "parts_unavailable_or_backordered")).toBe("not_fired");
    expect(stop(evaluateFrc(complete({ component: "compressor", age_years: "8" })), "major_component_age")).toBe("not_fired");
    expect(stop(evaluateFrc(complete({ component: "Control_Board", age_years: "9" })), "major_component_age")).toBe("fired");
  });

  it("fires a hard stop even when a price is missing", () => {
    const result = evaluateFrc(complete({ visit_number: 3, unresolved: true, trip_cost: null }));
    expect(result.route).toBe("replacement_review");
    expect(result.missing_inputs).toContain("trip_cost");
    expect(result.economic_outcome).toBe("unavailable");
  });

  it("counts unreadable or negative values as missing instead of guessing", () => {
    const result = evaluateFrc(complete({ age_years: "-1", unresolved: "maybe", parts_cost: "abc" }));
    expect(result.missing_inputs).toEqual(expect.arrayContaining(["age_years", "unresolved", "parts_cost"]));
    expect(result.route).toBe("manual_review_incomplete");
  });
});

describe("Legacy formulas", () => {
  const sears = (overrides: Partial<RrInput>): RrInput => ({
    calculator_type: "Standard", servicer_type: "Sears Tech", repair_hours: "0", ...overrides,
  });

  it("repairs a Sears Tech job only when strictly cheaper", () => {
    const repair = evaluateLegacy(sears({ parts: [{ cost: "100", quantity: 1 }], replacement_cost: "200" }));
    expect(repair.costs).toMatchObject({ labor: "27.00", current_repair: "127.00" });
    expect(repair.economic_outcome).toBe("REPAIR");
    expect(repair.route).toBe("continue_authorization");
    const equal = evaluateLegacy(sears({ parts: [{ cost: "173", quantity: 1 }], replacement_cost: "200" }));
    expect(equal.costs.current_repair).toBe("200.00");
    expect(equal.economic_outcome).toBe("REPLACE");
    expect(equal.route).toBe("replacement_review");
  });

  it("applies the PA 2.0 age valuation and refuses a blank age band", () => {
    const pa = (cost: string, ageBand: string) => evaluateLegacy(sears({
      calculator_type: "PA 2.0", parts: [{ cost, quantity: 1 }], replacement_cost: "1000", age_band: ageBand,
    }));
    expect(pa("172", "15+ years").costs.comparison).toBe("200.00");
    expect(pa("172", "15+ years").economic_outcome).toBe("REPAIR");
    expect(pa("173", "15+ years").economic_outcome).toBe("REPLACE");
    const blank = pa("10", "");
    expect(blank.route).toBe("manual_review_incomplete");
    expect(blank.missing_inputs).toContain("age_band");
  });

  it("returns First American and AHS estimates without a replacement value", () => {
    const fa = evaluateLegacy({
      calculator_type: "First American Parts Estimation", parts: [{ sell_price: "100", quantity: 2 }],
      labor_category: "Minor", tax_rate: "0.10",
    });
    expect(fa.costs).toMatchObject({ parts: "150.00", labor: "135.00", tax: "28.50", current_repair: "313.50" });
    expect(fa.outcome_kind).toBe("estimate");
    expect(fa.economic_outcome).toBe("First American Parts Estimation - Minor Repair");
    const ahs = evaluateLegacy({
      calculator_type: "American Homeshield Parts Estimator", parts: [{ sell_price: "200", quantity: 1 }], labor_category: "Major",
    });
    expect(ahs.costs).toMatchObject({ parts: "140.00", labor: "275.00", current_repair: "415.00" });
    expect(ahs.warnings).toContain("No sales-tax rate was supplied. Tax was not applied.");
  });

  it("applies a custom estimator's tax and a contractor's labor without the Sears fee", () => {
    const custom = evaluateLegacy({
      calculator_type: "Custom Program", minor_labor_rate: "10", major_labor_rate: "20", include_tax: true,
      parts: [{ cost: "100", sell_price: "100", quantity: 1 }], labor_category: "Minor", tax_rate: "0.05",
    });
    expect(custom.costs).toMatchObject({ tax: "5.50", current_repair: "115.50" });
    const contractor = evaluateLegacy({
      calculator_type: "Standard", parts: [{ cost: "0", quantity: 1 }], servicer_type: "1099",
      labor_category: "Sealed System", replacement_cost: "200",
    });
    expect(contractor.costs.labor).toBe("105.00");
    expect(contractor.labor_method).toBe("contractor_1099");
  });

  it("caps Sears Protect Home Warranty replacement at $3,500, also when there is no reference", () => {
    const capped = evaluateLegacy(sears({
      proc_id: "Sears Protect Home Warranty 100", appliance_type: "Ref - Built In",
      parts: [{ cost: "100", quantity: 1 }], repair_hours: "1",
    }));
    expect(capped.costs.replacement).toBe("3500.00");
    expect(capped.warnings.some((warning) => warning.includes("3,500"))).toBe(true);
    const missing = evaluateLegacy(sears({
      proc_id: "Program Sears Protect Home Warranty", appliance_type: "HVAC", parts: [{ cost: "100", quantity: 1 }], repair_hours: "1",
    }));
    expect(missing.costs.comparison).toBe("3500.00");
  });

  it("uses the catalog price when no amount is entered", () => {
    const result = evaluateLegacy(sears({
      appliance_type: "Washer (Top Load) Basic", parts: [{ cost: "100", quantity: 1 }], repair_hours: "1",
    }));
    expect(result.costs.replacement).toBe("520.00");
    expect(result.economic_outcome).toBe("REPAIR");
  });
});

describe("summary text", () => {
  it("names the recommendation, amounts and open checks, and says nothing was authorized", () => {
    const text = rrSummaryText(evaluateFrc(complete({ trip_cost: null })), "8175-13538277");
    expect(text).toContain("Service order: 8175-13538277");
    expect(text).toContain("Recommendation: Need more information (Forward Repair Cost)");
    expect(text).toContain("Nothing was purchased or authorized");
    expect(text).toContain("Open checks: Trip charge");
  });
});

// ---------------------------------------------------------------------------
// Prefill
// ---------------------------------------------------------------------------

const techhub = (overrides: Record<string, string[]> = {}, at = "2026-10-15T16:36:18") =>
  Object.entries({
    deLabor: ["85225~CC~0.00", "84100~CC~344.95", "60000~CC~99.00"],
    deTripCharge: ["CC~139.00"],
    applianceAssessment: ["4~4~Well Maintained"],
    ...overrides,
  }).flatMap(([name, values]) => values.map((value) => ({ CRT_TS: at, UDF_FLD_NM: name, UDF_FLD_VAL_TX: value })));

const parts = (...lines: Array<Record<string, unknown>>) => lines.length ? lines : [
  { SVC_PRT_STS_CD: "H", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "253.67" },
  { SVC_PRT_STS_CD: "H", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "220.73" },
];

const row = (overrides: Record<string, unknown> = {}) => ({
  MDS_CD: "Washer", AP_PCHS_DATE: "2020-01-01", SL_DT: "2010-01-01", JOB_CD_DS: " door gasket ", ...overrides,
});

const prefill = (overrides: Partial<Parameters<typeof buildRepairReplacePrefill>[0]> = {}) =>
  buildRepairReplacePrefill({ serviceOrder: "8175-13538277", row: row(), asOf: "2024-01-01", ...overrides });

describe("prefill mapping", () => {
  it("fills only the proven fields, each with its source", () => {
    const result = prefill({ techhub: techhub(), parts: parts() });
    expect(result.status).toBe("found");
    expect(result.manual_fallback).toBe(true);
    expect(result.fields).toEqual({
      appliance_type: { value: "washer", source: "snowflake", source_field: "MDS_CD" },
      age_years: { value: "4.00", source: "snowflake", source_field: "AP_PCHS_DATE relative to the lookup date", observed_at: "2024-01-01" },
      labor_cost: { value: "443.95", source: "snowflake", source_field: "TechHub deLabor estimate (3 lines)", observed_at: "2026-10-15T16:36:18" },
      trip_cost: { value: "139.00", source: "snowflake", source_field: "TechHub deTripCharge", observed_at: "2026-10-15T16:36:18" },
      technician_confident: { value: true, source: "snowflake", source_field: "TechHub applianceAssessment repair confidence 4 of 5", observed_at: "2026-10-15T16:36:18" },
    });
    expect(result.warnings).toContain(
      "Billed job code is 'door gasket'. That is not necessarily the failed component, so component was not filled.",
    );
    for (const name of ["component", "replacement_cost", "visit_number", "unresolved", "failed_attempt_count",
      "other_service_orders_12mo", "same_part_or_system_repeat", "parts_available", "backorder_days", "contract_spend"]) {
      expect(result.missing_fields).toContain(name);
    }
  });

  it("needs appliance, age and labor for found", () => {
    expect(RR_AUTHORITATIVE_FIELDS).toEqual(["appliance_type", "age_years", "labor_cost"]);
    expect(prefill().status).toBe("partial");
  });

  it("uses the sale date only when the purchase date is blank, and never a negative or unreadable age", () => {
    expect(prefill({ row: row({ AP_PCHS_DATE: "", SL_DT: "2022-01-01" }) }).fields.age_years)
      .toMatchObject({ value: "2.00", source_field: "SL_DT relative to the lookup date" });
    const future = prefill({ row: row({ AP_PCHS_DATE: "2025-01-01" }) });
    expect(future.fields.age_years).toBeUndefined();
    expect(future.warnings).toContain("AP_PCHS_DATE is after the lookup date, so age was not filled.");
    const unreadable = prefill({ row: row({ AP_PCHS_DATE: "not-a-date", SL_DT: "2020-01-01" }) });
    expect(unreadable.fields.age_years).toBeUndefined();
    expect(prefill({ row: row({ AP_PCHS_DATE: new Date(Date.UTC(2020, 0, 1)) }) }).fields.age_years?.value).toBe("4.00");
    expect(prefill({ row: row({ SL_DT: null }), asOf: "2020-06-01" }).fields.age_years?.value).toBe("0.42");
  });

  it("maps only the four appliances from MDS_CD", () => {
    for (const [raw, expected] of Object.entries({
      DISHWASHBI: "dishwasher", WASHERFL: "washer", REFRIGBF: "refrigerator", RANGEEG: "range",
      OVENBI: "range", OVENBI1YR5: "range", LWRANGE: "range", "Washing Machine": "washer", "electric range": "range",
    })) {
      expect(prefill({ row: row({ MDS_CD: raw }) }).fields.appliance_type?.value, raw).toBe(expected);
    }
    for (const raw of ["dryer", "RANGEHOOD", "RANGEHOD1YR5", "RANGEHBLW1Y3", "OVENMWAVE", "OVENBIMW", "COOKTOP", "REF"]) {
      expect(prefill({ row: row({ MDS_CD: raw }) }).fields.appliance_type, raw).toBeUndefined();
    }
  });

  it("falls back to the technician's appliance only when it is one of the four", () => {
    expect(prefill({ row: row({ MDS_CD: "DRYER" }), ticketApplianceKind: "refrigerator" }).fields.appliance_type)
      .toEqual({ value: "refrigerator", source: "ticket", source_field: "Appliance the technician picked" });
    expect(prefill({ row: row({ MDS_CD: "DRYER" }), ticketApplianceKind: "oven_combo" }).fields.appliance_type).toBeUndefined();
    // The service order wins over the ticket.
    expect(prefill({ ticketApplianceKind: "range" }).fields.appliance_type?.source).toBe("snowflake");
  });

  it("never fills labor from a $0 or unreadable estimate, and the latest TechHub submission wins", () => {
    const covered = prefill({ techhub: techhub({ deLabor: ["84100~SP~0.00"], deTripCharge: ["SP~0.00"] }) });
    expect(covered.fields.labor_cost).toBeUndefined();
    expect(covered.fields.trip_cost).toBeUndefined();
    for (const bad of [["84100~CC"], ["84100~CC~abc"], ["84100~CC~-5"]]) {
      expect(prefill({ techhub: techhub({ deLabor: bad }) }).fields.labor_cost, bad[0]).toBeUndefined();
    }
    const earlier = techhub({ deLabor: ["84100~CC~999.00"], deTripCharge: ["CC~99.00"], applianceAssessment: ["2~1~Worn"] }, "2026-10-01T09:00:00");
    const later = techhub({ deLabor: ["84100~CC~344.95", "84100~CC~344.95"] });
    const result = prefill({ techhub: [...earlier, ...later] });
    expect(result.fields.labor_cost?.value).toBe("344.95");
    expect(result.fields.trip_cost?.value).toBe("139.00");
    expect(result.fields.technician_confident?.value).toBe(true);
  });

  it("maps confidence 4-5 to true and 1-2 to false, and leaves 3 for the person", () => {
    for (const [raw, expected] of [["5~5~Noise", true], ["4~4", true], ["3~2~Worn", false], ["5~1", false]] as const) {
      expect(prefill({ techhub: techhub({ applianceAssessment: [raw] }) }).fields.technician_confident?.value, raw).toBe(expected);
    }
    for (const raw of ["4~3~Worn", "garbage", "4~9"]) {
      expect(prefill({ techhub: techhub({ applianceAssessment: [raw] }) }).fields.technician_confident, raw).toBeUndefined();
    }
  });

  it("never fills parts cost from selling prices, marks parts available only from a received line, never unavailable", () => {
    const onOrder = prefill({ parts: parts(
      { SVC_PRT_STS_CD: "H", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "100.00" },
      { SVC_PRT_STS_CD: "O", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "50.00" },
      { SVC_PRT_STS_CD: "X", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "900.00" },
      { SVC_PRT_STS_CD: "V", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "900.00" },
      { SVC_PRT_STS_CD: "R", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "900.00" },
    ) });
    expect(onOrder.fields.parts_cost).toBeUndefined();
    expect(onOrder.warnings.some((warning) => warning.includes("selling prices only"))).toBe(true);
    expect(onOrder.fields.parts_available).toBeUndefined();
    expect(onOrder.warnings.some((warning) => warning.includes("on order but none has arrived yet"))).toBe(true);
    const installed = prefill({ parts: parts({ SVC_PRT_STS_CD: "I", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "100.00" }) });
    expect(installed.fields.parts_available?.value).toBe(true);
  });

  it("keeps a failed lookup a failed lookup", () => {
    const failed = buildRepairReplacePrefill({ serviceOrder: "8175-13538277", row: null, unavailable: true });
    expect(failed.status).toBe("unavailable");
    expect(failed.fields).toEqual({});
    expect(failed.warnings).toContain("A failed lookup is not parts-unavailable and is not a failed attempt.");
    const none = buildRepairReplacePrefill({ serviceOrder: "8175-13538277", row: null });
    expect(none.status).toBe("not_found");
    expect(none.warnings.join(" ").toLowerCase()).not.toContain("unavailable");
  });

  it("replays the saved live orders the same way the Python package did", () => {
    const saved = JSON.parse(readFileSync(path.join(__dirname, "fixtures/repair-replace-orders.json"), "utf8"));
    expect(saved.orders.length).toBeGreaterThanOrEqual(4);
    for (const order of saved.orders) {
      const result = buildRepairReplacePrefill({
        serviceOrder: order.service_order, row: order.row, techhub: order.techhub, parts: order.parts, asOf: order.captured_at,
      });
      const filled = Object.fromEntries(Object.entries(result.fields).map(([key, field]) => [key, field!.value]));
      expect(result.status, order.service_order).toBe(order.prefill_status);
      // VRS Express no longer fills parts_cost from NPSXTPN selling prices
      // (2026-10-30: parts cost is the cost); everything else matches Python.
      const { parts_cost: _sell, ...expected } = order.prefill_fields;
      expect(filled, order.service_order).toEqual(expected);
    }
  });
});

describe("prefill lookup", () => {
  const settled = (rows: any[]): PromiseSettledResult<any[]> => ({ status: "fulfilled", value: rows });
  const failed = (message: string): PromiseSettledResult<any[]> => ({ status: "rejected", reason: new Error(message) });

  it("runs four statements keyed on SO and district, and keeps rows under the resolved unit only", async () => {
    const query = vi.fn<AhsPrefillQuery>(async () => [
      settled([{ SERVICE_UNIT: "0008366", UNIT_COUNT: 1, MDS_CD: "WASHERFL" }]),
      settled([{ SERVICE_UNIT: "0008366", CRT_TS: "2026-10-15T16:36:18", UDF_FLD_NM: "deLabor", UDF_FLD_VAL_TX: "1~CC~10" },
        { SERVICE_UNIT: "0009999", CRT_TS: "2026-10-15T16:36:18", UDF_FLD_NM: "deLabor", UDF_FLD_VAL_TX: "1~CC~999" }]),
      settled([{ SERVICE_UNIT: "0008366", SVC_PRT_STS_CD: "I", PRT_SEL_PRC_AM: "5" }]),
      settled([{ SERVICE_UNIT: "0008366", SERIAL_USABLE: true, H_SO: "10000001" },
        { SERVICE_UNIT: "0009999", SERIAL_USABLE: true, H_SO: "10000002" }]),
    ]);
    quietLogs();
    const result = await createRepairReplaceLookup(query)("7995", "11075199");
    const [statements] = query.mock.calls[0];
    expect(statements.map((s) => s.sqlText)).toEqual([
      REPAIR_REPLACE_ORDER_SQL, REPAIR_REPLACE_TECHHUB_SQL, REPAIR_REPLACE_PARTS_SQL, REPAIR_REPLACE_HISTORY_SQL,
    ]);
    expect(statements.map((s) => s.binds)).toEqual([
      ["11075199", "7995"], ["11075199", "11075199", "7995"], ["11075199", "11075199", "7995"],
      ["11075199", "7995", "11075199", "11075199"],
    ]);
    expect(result).toMatchObject({
      status: "found", techhub: [{ UDF_FLD_VAL_TX: "1~CC~10" }], parts: [{ PRT_SEL_PRC_AM: "5" }], history: [{ H_SO: "10000001" }],
    });
    expect((result as any).history).toHaveLength(1);
    // Placeholder binds: the history SQL has exactly four.
    expect(REPAIR_REPLACE_HISTORY_SQL.split("?").length - 1).toBe(4);
    expect(REPAIR_REPLACE_HISTORY_SQL).toContain("DATEADD(day, -365, CURRENT_DATE())");
    expect(REPAIR_REPLACE_TECHHUB_SQL).toContain("PRD_DB2.HS_DW_VIEWS.NPSXTFS");
    expect(REPAIR_REPLACE_TECHHUB_SQL).not.toContain("CC_LAB_NET");
  });

  it("keeps the order when the TechHub or parts statement fails, and is unavailable when the order statement fails", async () => {
    const spies = quietLogs();
    const partial = await createRepairReplaceLookup(async () => [
      settled([{ SERVICE_UNIT: "0008175", UNIT_COUNT: 2, MDS_CD: "SECRET-CODE" }]), failed("NPSXTFS does not exist"), failed("timeout"),
    ])("8175", "12345678");
    expect(partial).toMatchObject({ status: "found", techhub: null, parts: null, history: null });
    expect(await createRepairReplaceLookup(async () => [failed("bad column"), settled([]), settled([])])("8175", "12345678"))
      .toEqual({ status: "unavailable" });
    expect(await createRepairReplaceLookup(async () => [
      settled([{ SERVICE_UNIT: "0008366", UNIT_COUNT: 2 }]), settled([]), settled([]),
    ])("7995", "11075199")).toEqual({ status: "not_found" });
    expect(await createRepairReplaceLookup(vi.fn())("ABCD", "1")).toEqual({ status: "not_found" });
    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).join(" ");
    expect(logged).not.toContain("SECRET-CODE");
  });

  it("says when the lookup is off and warns per failed statement", async () => {
    const off = await loadRepairReplacePrefill("8175-13538277", { ticketApplianceKind: "washer" }, null);
    expect(off.status).toBe("unavailable");
    expect(off.warnings).toEqual(["The service-order lookup is off here. Enter the visit manually."]);
    expect(off.fields.appliance_type?.source).toBe("ticket");
    const partial = await loadRepairReplacePrefill("8175-13538277", {}, async () => ({
      status: "found", row: { MDS_CD: "WASHERFL" }, techhub: null, parts: null,
    }));
    expect(partial.warnings).toEqual(expect.arrayContaining([
      "TechHub lookup failed, so labor, trip, and confidence were not filled.",
      "Parts lookup failed, so parts_cost was not filled.",
    ]));
    const thrown = await loadRepairReplacePrefill("8175-13538277", {}, async () => { throw new Error("down"); });
    expect(thrown.status).toBe("unavailable");
  });

  it("asks HSSOM every time; the technician's age still wins over its purchase date", async () => {
    const snowflake = async () => ({ status: "found" as const, row: { MDS_CD: "WASHERFL" }, techhub: [], parts: [] });
    const hssom = vi.fn(async () => ({ status: "found" as const, purchaseDate: "2020-01-01" }));
    const dated = await loadRepairReplacePrefill("8175-13538277", {}, snowflake, hssom);
    expect(hssom).toHaveBeenCalledWith("8175", "13538277");
    expect(dated.fields.age_years).toMatchObject({ source: "hssom", source_field: "HSSOM purchase date relative to the lookup date" });
    hssom.mockClear();
    const told = await loadRepairReplacePrefill("8175-13538277", { techDetails: { ...TECH_DETAILS, applianceAgeYears: 3 } }, snowflake, hssom);
    expect(hssom).toHaveBeenCalledTimes(1);
    expect(told.fields.age_years).toMatchObject({ value: "3", source: "ticket" });
    const failed = await loadRepairReplacePrefill("8175-13538277", {}, snowflake, async () => { throw new Error("down"); });
    expect(failed.fields.age_years).toBeUndefined();
    const noRow = await loadRepairReplacePrefill("8175-13538277", {}, async () => ({ status: "not_found" as const }), hssom);
    expect(noRow.fields.age_years?.source).toBe("hssom");
  });
});

// Shapes from the live PROD order 7108-14201974 and QA orders (2026-10-29).
const SOM_FACTS: HssomRepairFacts = {
  tripCharge: 139,
  partsTaxRate: 0.0825,
  attemptCount: 2,
  previousAttemptCount: 1,
  providerId: "W2",
  jobCodes: [
    { jobCode: "13130", description: "Blower Sq. Cage Rep/Repl", chargeCode: "B", chargeAmount: 369, coverageCode: "CC" },
    { jobCode: "60000", description: "Helper Required", chargeCode: "Y", chargeAmount: 99, coverageCode: "CC" },
    { jobCode: "90300", description: "Service Completed", chargeCode: "B", chargeAmount: 139, coverageCode: "CC" },
  ],
  parts: [
    { price: 120.5, costPrice: 70.25, quantity: 1, status: "I" },
    { price: 40, localCost: 22, quantity: 1, status: "O" },
    { price: 999, costPrice: 600, quantity: 1, status: "X" },
    { price: 0, costPrice: 300, quantity: 1, status: "U" },
  ],
};

describe("prefill from SOM (HSSOM Order Lookup)", () => {
  const techhub = [
    { CRT_TS: "2026-10-01 10:00:00", UDF_FLD_NM: "deLabor", UDF_FLD_VAL_TX: "84100~CC~344.95" },
    { CRT_TS: "2026-10-01 10:00:00", UDF_FLD_NM: "deTripCharge", UDF_FLD_VAL_TX: "CC~89.00" },
  ];
  const parts = [{ SVC_PRT_STS_CD: "I", SVC_PRT_TYP_CD: "D", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: 10 }];

  it("fills parts, labor, trip, tax, visits and servicer from SOM ahead of TechHub and NPSXTPN", () => {
    const result = buildRepairReplacePrefill({
      serviceOrder: "7108-14201974", row: { MDS_CD: "WASHERFL" }, techhub, parts, hssom: SOM_FACTS, servicerType: "1099",
    });
    expect(result.fields.parts_cost).toMatchObject({ value: "92.25", source: "hssom", source_field: "SOM part cost (2 lines)" });
    expect(result.fields.labor_cost).toMatchObject({ value: "468.00", source: "hssom" });
    expect(result.fields.labor_cost?.source_field).toContain("13130 Blower Sq. Cage Rep/Repl $369.00");
    expect(result.fields.trip_cost).toMatchObject({ value: "139.00", source: "hssom" });
    expect(result.fields.tax_rate).toMatchObject({ value: "0.0825", source: "hssom" });
    expect(result.fields.visit_number).toMatchObject({ value: "2", source: "hssom" });
    expect(result.fields.servicer_type).toMatchObject({ value: "Sears Tech", source: "hssom" });
    expect(result.fields.parts_available).toMatchObject({ value: true, source: "hssom" });
    expect(result.warnings.some((w) => w.includes("90300 Service Completed") && w.includes("left out of labor_cost"))).toBe(true);
  });

  it("leaves a deductible job code out of labor (PROD 7108-14201974 shape)", () => {
    const result = buildRepairReplacePrefill({
      serviceOrder: "7108-14201974", row: null,
      hssom: {
        jobCodes: [
          { jobCode: "56320", description: "Main PCB/Replace", chargeCode: "B", chargeAmount: 171, coverageCode: "PT" },
          { jobCode: "90000", description: "Deductible", chargeCode: "X", chargeAmount: 75, coverageCode: "CC" },
        ],
        parts: [
          { price: 0, costPrice: 0, quantity: 1, status: "X" }, { price: 0, costPrice: 0, quantity: 1, status: "U" },
          { price: 219.92, costPrice: 131.95, quantity: 1, status: "R" },
          { price: 350.95, costPrice: 210.57, quantity: 1, status: "O" }, { price: 353.64, costPrice: 212.18, quantity: 1, status: "O" },
        ],
      },
    });
    expect(result.fields.labor_cost).toMatchObject({ value: "171.00", source: "hssom" });
    expect(result.fields.parts_cost).toMatchObject({ value: "422.75", source: "hssom" });
    expect(result.warnings.some((w) => w.includes("90000 Deductible") && w.includes("not repair labor"))).toBe(true);
  });

  it("takes each part line's cost as the line total, never times quantity (PROD 7995-14335804 shape)", () => {
    const sell = [236.79, 75.85, 198.19, 127.13, 171.67, 24.83, 35.16];
    const result = buildRepairReplacePrefill({
      serviceOrder: "7995-14335804", row: null,
      hssom: {
        jobCodes: [],
        parts: [
          ...sell.map((price) => ({ price, costPrice: price / 2, quantity: 1, status: "F" })),
          { price: 142.44, costPrice: 71.22, quantity: 6, status: "F" },
        ],
      },
    });
    // Sell total 1012.06 (not 1724.26, which multiplied the screws line by 6); cost is half.
    expect(result.fields.parts_cost).toMatchObject({ value: "506.03", source: "hssom" });
    expect(result.fields.sell_price).toMatchObject({ value: "1012.06", source: "hssom", source_field: "SOM part sell price (8 lines)" });
    expect(result.fields.parts_available).toMatchObject({ value: true, source: "hssom" });
    expect(result.warnings.some((w) => w.includes("quantity above 1") && w.includes("line total"))).toBe(true);
  });

  it("leaves 9xxxx job codes out of labor whatever their description (8228-14169759 showed labor = trip)", () => {
    const tripOnly = buildRepairReplacePrefill({
      serviceOrder: "8228-14169759", row: null,
      hssom: { tripCharge: 129, jobCodes: [{ jobCode: "90150", description: "SVC CALL", chargeAmount: 129 }], parts: [] },
    });
    expect(tripOnly.fields.labor_cost).toBeUndefined();
    expect(tripOnly.fields.trip_cost?.value).toBe("129.00");
    expect(tripOnly.warnings.some((w) => w.includes("90150 SVC CALL") && w.includes("not repair labor"))).toBe(true);
    const repair = buildRepairReplacePrefill({
      serviceOrder: "8228-14169759", row: null,
      hssom: { tripCharge: 129, parts: [], jobCodes: [
        { jobCode: "14335", description: "Coupler, Motor/Gearcase", chargeAmount: 171 },
        { jobCode: "90000", description: "Ded", chargeAmount: 129 },
      ] },
    });
    expect(repair.fields.labor_cost?.value).toBe("171.00");
  });

  it("leaves parts cost blank when a SOM line has no cost, and never uses the sell price", () => {
    for (const line of [{ price: 50, quantity: 1, status: "I" }, { price: 50, costPrice: 0, quantity: 1, status: "I" }]) {
      const result = buildRepairReplacePrefill({ serviceOrder: "7995-14335804", row: null, hssom: { jobCodes: [], parts: [line] } });
      expect(result.fields.parts_cost).toBeUndefined();
      expect(result.fields.sell_price?.value).toBe("50.00");
      expect(result.warnings.some((w) => w.includes("SOM part line has no cost"))).toBe(true);
    }
    const free = buildRepairReplacePrefill({
      serviceOrder: "7995-14335804", row: null,
      hssom: { jobCodes: [], parts: [{ price: 0, costPrice: 0, quantity: 1, status: "I" }, { price: 30, costPrice: 12.5, quantity: 1, status: "I" }] },
    });
    expect(free.fields.parts_cost?.value).toBe("12.50");
  });

  it("falls back to TechHub when SOM has no usable amounts", () => {
    const covered: HssomRepairFacts = {
      jobCodes: [{ jobCode: "13130", description: "Blower Sq. Cage Rep/Repl", chargeAmount: 0 }],
      parts: [{ quantity: 1, status: "I" }],
    };
    const result = buildRepairReplacePrefill({ serviceOrder: "7108-14201974", row: { MDS_CD: "WASHERFL" }, techhub, parts, hssom: covered });
    expect(result.fields.labor_cost).toMatchObject({ value: "344.95", source: "snowflake" });
    expect(result.fields.trip_cost).toMatchObject({ value: "89.00", source: "snowflake" });
    expect(result.fields.parts_cost).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("charge $0.00 to the customer (covered)"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("SOM part line has no cost"))).toBe(true);
  });

  it("uses SOM when Snowflake has no row, and the account servicer when SOM has no provider", () => {
    const result = buildRepairReplacePrefill({
      serviceOrder: "7108-14201974", row: null, hssom: { ...SOM_FACTS, providerId: undefined }, servicerType: "1099",
    });
    expect(result.fields.labor_cost?.source).toBe("hssom");
    expect(result.fields.servicer_type).toMatchObject({ value: "1099", source: "ticket" });
    const other = buildRepairReplacePrefill({ serviceOrder: "7108-14201974", row: null, hssom: { ...SOM_FACTS, providerId: "SB" } });
    expect(other.fields.servicer_type).toMatchObject({ value: "1099", source: "hssom" });
  });

  it("passes the lookup's repair facts through", async () => {
    const snowflake = async () => ({ status: "found" as const, row: { MDS_CD: "WASHERFL" }, techhub: [], parts: [] });
    const hssom = async () => ({ status: "found" as const, repair: SOM_FACTS });
    const result = await loadRepairReplacePrefill("7108-14201974", {}, snowflake, hssom);
    expect(result.fields.labor_cost?.source).toBe("hssom");
    expect(result.missing_fields).not.toContain("tax_rate");
  });
});

describe("legacy formulas with the order's labor and tax", () => {
  it("uses an entered labor amount ahead of servicer and hours, and taxes parts on Standard", () => {
    const result = evaluateLegacy({
      calculator_type: "Standard", appliance_type: "Refrigerator Basic", servicer_type: "Sears Tech",
      labor_cost: "468.00", tax_rate: "0.10", parts: [{ cost: "200.00", sell_price: "200.00", quantity: 1 }],
    });
    expect(result.costs.labor).toBe("468.00");
    expect(result.costs.tax).toBe("20.00");
    expect(result.explanation).toContain("labor method entered");
    const noRate = evaluateLegacy({
      calculator_type: "Standard", appliance_type: "Refrigerator Basic", servicer_type: "Sears Tech",
      repair_hours: "2", parts: [{ cost: "200.00", sell_price: "200.00", quantity: 1 }],
    });
    expect(noRate.costs.labor).toBe("91.00");
    expect(noRate.costs.tax).toBe("0.00");
  });
});

const TECH_DETAILS = {
  applianceGrade: "high" as const, applianceColor: "White" as const, applianceLocation: "Kitchen" as const, partFunction: "Pumps water",
};

describe("prefill from parts labor lines, CC_LAB_NET, history and WOM", () => {
  it("keeps labor-coded part lines out of parts and uses them for labor when nothing else has labor", () => {
    const result = prefill({ techhub: [], parts: [
      { SVC_PRT_STS_CD: "O", SVC_PRT_TYP_CD: "D", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "100.00" },
      { SVC_PRT_STS_CD: "O", SVC_PRT_TYP_CD: "L", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "89.50" },
      { SVC_PRT_STS_CD: "X", SVC_PRT_TYP_CD: "L", SVC_PRT_QT: 1, PRT_SEL_PRC_AM: "500" },
    ] });
    expect(result.fields.parts_cost).toBeUndefined();
    expect(result.fields.labor_cost).toMatchObject({ value: "89.50", source_field: "NPSXTPN labor lines (1 line, type L)" });
    const techhubWins = prefill({ techhub: techhub(), parts: [{ SVC_PRT_STS_CD: "O", SVC_PRT_TYP_CD: "L", PRT_SEL_PRC_AM: "89.50" }] });
    expect(techhubWins.fields.labor_cost?.source_field).toContain("TechHub");
  });

  it("uses CC_LAB_NET for the trip charge only when TechHub and WOM have none", () => {
    expect(prefill({ row: row({ CC_LAB_NET: "139" }), techhub: [] }).fields.trip_cost)
      .toMatchObject({ value: "139.00", source_field: "CC_LAB_NET (matches the trip charge on most orders; confirm)" });
    expect(prefill({ row: row({ CC_LAB_NET: "0" }), techhub: [] }).fields.trip_cost).toBeUndefined();
    expect(prefill({ row: row({ CC_LAB_NET: "139" }), techhub: [], wom: { tripCharge: 99 } }).fields.trip_cost)
      .toMatchObject({ value: "99.00", source: "wom" });
  });

  it("counts other orders on the same appliance, not cancelled, and finds repeated parts", () => {
    const h = (so: string | null, status = "CO", same = 0) =>
      ({ SERVICE_UNIT: "0008175", SERIAL_USABLE: true, H_SO: so, H_STATUS: status, SAME_PART_LINES: same });
    const none = prefill({ history: [h(null)] });
    expect(none.fields.other_service_orders_12mo?.value).toBe("0");
    expect(none.fields.same_part_or_system_repeat?.value).toBe(false);
    const repeat = prefill({ history: [h("1"), h("2", "CA", 3), h("3", "CO", 2)] });
    expect(repeat.fields.other_service_orders_12mo?.value).toBe("2");
    expect(repeat.fields.same_part_or_system_repeat).toMatchObject({ value: true, source: "snowflake" });
    const different = prefill({ history: [h("1")] });
    expect(different.fields.same_part_or_system_repeat).toBeUndefined();
    expect(different.warnings).toContain("Earlier orders on this appliance installed different part numbers. Check whether it is the same system.");
    const placeholder = prefill({ history: [{ SERVICE_UNIT: "0008175", SERIAL_USABLE: false, H_SO: null }] });
    expect(placeholder.fields.other_service_orders_12mo).toBeUndefined();
    expect(prefill({ history: null }).fields.other_service_orders_12mo).toBeUndefined();
  });

  it("fills visits from WOM, and WOM labor after TechHub", () => {
    const result = prefill({ techhub: [], wom: { visitNumber: 2, unresolved: true, failedAttemptCount: 1, laborTotal: 210, laborLineCount: 2 } });
    expect(result.fields.visit_number).toMatchObject({ value: "2", source: "wom" });
    expect(result.fields.unresolved).toMatchObject({ value: true, source: "wom" });
    expect(result.fields.failed_attempt_count?.value).toBe("1");
    expect(result.fields.labor_cost).toMatchObject({ value: "210.00", source: "wom", source_field: "WOM labor job codes (2 lines)" });
    expect(prefill({ techhub: techhub(), wom: { laborTotal: 210 } }).fields.labor_cost?.source).toBe("snowflake");
    expect(prefill({ row: null, wom: { visitNumber: 3 } }).fields.visit_number?.value).toBe("3");
    expect(prefill({ wom: { laborTotal: 0, visitNumber: 0 } }).fields.visit_number).toBeUndefined();
  });

  it("fills the servicer from the technician's account", () => {
    expect(prefill({ servicerType: "1099" }).fields.servicer_type).toMatchObject({ value: "1099", source: "ticket" });
    expect(prefill({ servicerType: null }).fields.servicer_type).toBeUndefined();
  });

  it("passes WOM facts and warnings through the loader, and never needs WOM", async () => {
    const snowflake = async () => ({ status: "found" as const, row: { MDS_CD: "WASHERFL" }, techhub: [], parts: [], history: [] });
    const wom = vi.fn(async () => ({ status: "found" as const, facts: { visitNumber: 2 }, warnings: ["A WOM labor line has no readable price, so labor was not filled."] }));
    const result = await loadRepairReplacePrefill("8175-13538277", {}, snowflake, null, wom);
    expect(wom).toHaveBeenCalledWith("8175", "13538277");
    expect(result.fields.visit_number?.value).toBe("2");
    expect(result.warnings).toContain("A WOM labor line has no readable price, so labor was not filled.");
    const down = await loadRepairReplacePrefill("8175-13538277", {}, snowflake, null, async () => { throw new Error("x"); });
    expect(down.fields.visit_number).toBeUndefined();
  });
});

describe("prefill from what the technician entered", () => {
  it("uses the technician's age ahead of every date, and warns when a date disagrees", () => {
    const told = prefill({
      row: row({ AP_PCHS_DATE: "2023-09-01" }), techDetails: { ...TECH_DETAILS, applianceAgeYears: 8 },
    });
    expect(told.fields.age_years).toEqual({ value: "8", source: "ticket", source_field: "Age the technician entered (from the customer)" });
    expect(told.warnings).toContain("The technician entered 8 years; AP_PCHS_DATE gives 0.33. Age uses the technician's.");
    const close = prefill({ row: row({ AP_PCHS_DATE: "2016-01-01" }), techDetails: { ...TECH_DETAILS, applianceAgeYears: 8 } });
    expect(close.warnings.some((warning) => warning.startsWith("The technician entered"))).toBe(false);
    const zero = prefill({ row: null, techDetails: { ...TECH_DETAILS, applianceAgeYears: 0 } });
    expect(zero.fields.age_years?.value).toBe("0");
    expect(prefill({ row: row(), techDetails: TECH_DETAILS }).fields.age_years?.source).toBe("snowflake");
  });

  it("orders the dates AP_PCHS_DATE, HSSOM, then SL_DT", () => {
    const both = prefill({ row: row({ AP_PCHS_DATE: "2020-01-01", SL_DT: "2023-01-01" }), hssomPurchaseDate: "2018-01-01" });
    expect(both.fields.age_years?.source_field).toBe("AP_PCHS_DATE relative to the lookup date");
    const hssom = prefill({ row: row({ AP_PCHS_DATE: null, SL_DT: "2023-01-01" }), hssomPurchaseDate: "2018-01-01" });
    expect(hssom.fields.age_years).toMatchObject({ source: "hssom", value: "6.00" });
    const sale = prefill({ row: row({ AP_PCHS_DATE: null, SL_DT: "2023-01-01" }) });
    expect(sale.fields.age_years?.source_field).toBe("SL_DT relative to the lookup date");
  });

  it("picks the catalog row the grade names, and says when it names none", () => {
    const ref = (kind: string, grade: "low" | "medium" | "high") =>
      prefill({ row: row(), ticketApplianceKind: kind, techDetails: { ...TECH_DETAILS, applianceGrade: grade } });
    expect(ref("refrigerator", "medium").fields.appliance_reference).toEqual({
      value: "Refrigerator Mid Level", source: "ticket", source_field: "Technician's grade (Medium) and appliance",
    });
    expect(ref("dishwasher", "high").fields.appliance_reference?.value).toBe("Dishwasher High End");
    expect(ref("range", "low").fields.appliance_reference?.value).toBe("Range Basic");
    const medium = ref("dishwasher", "medium");
    expect(medium.fields.appliance_reference).toBeUndefined();
    expect(medium.missing_fields).toContain("appliance_reference");
    expect(medium.warnings).toContain("The technician graded the appliance Medium, which has no single reference. Pick Basic or High End.");
    expect(ref("washer", "high").warnings).toContain("The technician graded the washer High. Pick the top or front load reference.");
    expect(ref("microwave", "high").fields.appliance_reference).toBeUndefined();
    expect(prefill({ row: row(), ticketApplianceKind: "refrigerator" }).fields.appliance_reference).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const AGENT = { id: 7, role: "vrs_agent" };
const OTHER_AGENT = { id: 8, role: "vrs_agent" };
const ADMIN = { id: 1, role: "admin" };
const TECH = { id: 40, role: "technician" };

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: 601, serviceOrder: "8175-13538277", warrantyType: "sears_protect", requestType: "authorization",
    ticketStatus: "pending", assignedTo: AGENT.id, applianceKind: "washer", procId: "SPHW100", technicianId: 40, ...overrides,
  } as any;
}

function harness(options: { submission?: any; enabled?: boolean; companyName?: string } = {}) {
  const submission = options.submission ?? ticket();
  const deps = {
    authenticateToken: (req: any, res: any, next: any) => {
      const header = req.headers["x-test-user"];
      if (!header) return res.status(401).json({ error: "Unauthorized" });
      req.user = JSON.parse(String(header));
      next();
    },
    requireRole: (...roles: string[]) => (req: any, res: any, next: any) =>
      roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Access denied" }),
    isEnabled: () => options.enabled ?? true,
    getSubmission: vi.fn(async (id: number) => (id === submission.id ? submission : undefined)),
    getUser: vi.fn(async (id: number) => (id === 40 ? { role: "technician", companyName: options.companyName ?? null } : undefined)),
    loadPrefill: vi.fn(async (serviceOrder: string, ticketInput: RepairReplaceTicketInput) => buildRepairReplacePrefill({
      serviceOrder, row: row(), techhub: techhub(), parts: parts(), ...ticketInput, asOf: "2024-01-01",
    })),
    createNote: vi.fn(async () => ({})),
  } satisfies RepairReplaceApiDeps;
  const app = express();
  app.use(express.json());
  registerRepairReplaceApi(app, deps);
  return { app, deps };
}

const as = (user: object) => ({ "x-test-user": JSON.stringify(user) });

describe("repair / replace endpoints", () => {
  it("serve only the assigned agent or an admin, only on Sears Protect tickets, only when enabled", async () => {
    quietLogs();
    const { app, deps } = harness();
    expect((await request(app).get("/api/submissions/601/repair-replace/prefill")).status).toBe(401);
    expect((await request(app).get("/api/submissions/601/repair-replace/prefill").set(as(TECH))).status).toBe(403);
    expect((await request(app).get("/api/submissions/601/repair-replace/prefill").set(as(OTHER_AGENT))).status).toBe(403);
    expect((await request(app).get("/api/submissions/602/repair-replace/prefill").set(as(AGENT))).status).toBe(404);
    expect((await request(app).get("/api/submissions/601/repair-replace/prefill").set(as(ADMIN))).status).toBe(200);
    const ahs = harness({ submission: ticket({ warrantyType: "american_home_shield" }) });
    expect((await request(ahs.app).get("/api/submissions/601/repair-replace/prefill").set(as(AGENT))).status).toBe(400);
    const off = harness({ enabled: false });
    expect((await request(off.app).get("/api/submissions/601/repair-replace/prefill").set(as(AGENT))).status).toBe(404);
    expect(off.deps.getSubmission).not.toHaveBeenCalled();
    expect(deps.loadPrefill).toHaveBeenCalledWith("8175-13538277", { ticketApplianceKind: "washer", techDetails: null, servicerType: "Sears Tech" });
    const provider = harness({ companyName: "A1 APPLIANCE REPAIR" });
    await request(provider.app).get("/api/submissions/601/repair-replace/prefill").set(as(AGENT));
    expect(provider.deps.loadPrefill.mock.calls[0][1]).toMatchObject({ servicerType: "1099" });
    const told = harness({ submission: ticket({ techApplianceDetails: JSON.stringify({ ...TECH_DETAILS, applianceAgeYears: 6 }) }) });
    await request(told.app).get("/api/submissions/601/repair-replace/prefill").set(as(AGENT));
    expect(told.deps.loadPrefill).toHaveBeenCalledWith("8175-13538277", {
      ticketApplianceKind: "washer", techDetails: { ...TECH_DETAILS, applianceAgeYears: 6 }, servicerType: "Sears Tech",
    });
  });

  it("returns the prefill contract", async () => {
    quietLogs();
    const res = await request(harness().app).get("/api/submissions/601/repair-replace/prefill").set(as(AGENT));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ service_order: "8175-13538277", status: "found", manual_fallback: true });
    expect(res.body.fields.labor_cost.value).toBe("443.95");
  });

  it("recomputes on the server and saves a staff-only note", async () => {
    quietLogs();
    const { app, deps } = harness();
    const res = await request(app).post("/api/submissions/601/repair-replace/note").set(as(AGENT)).send({
      model: "frc",
      input: washerExample({ repeat_probability_override: undefined }),
      legacyInput: { calculator_type: "Standard", servicer_type: "Sears Tech", repair_hours: "1", parts: [{ cost: "260" }], replacement_cost: "850" },
    });
    expect(res.status).toBe(201);
    expect(res.body.result.route).toBe("replacement_review");
    expect(res.body.legacy.economic_outcome).toBe("REPAIR");
    expect(deps.createNote).toHaveBeenCalledTimes(1);
    const note = (deps.createNote.mock.calls[0] as any[])[0];
    expect(note).toMatchObject({ submissionId: 601, authorId: AGENT.id, authorRole: "vrs_agent", visibility: "staff_only" });
    expect(note.body).toContain("Recommendation: Replacement review (Forward Repair Cost)");
    expect(note.body).toContain("Legacy comparison (Standard): Continue this repair");
    expect(note.body.length).toBeLessThanOrEqual(2000);
  });

  it("refuses a client-supplied result, an override, or unknown fields", async () => {
    quietLogs();
    const { app, deps } = harness();
    for (const body of [
      { model: "frc", input: complete(), result: { route: "continue_authorization" } },
      { model: "frc", input: { ...complete(), repeat_probability_override: "0" } },
      { model: "frc", input: { ...complete(), customer_name: "x" } },
      { model: "nope", input: complete() },
    ]) {
      expect((await request(app).post("/api/submissions/601/repair-replace/note").set(as(AGENT)).send(body)).status).toBe(400);
    }
    expect(deps.createNote).not.toHaveBeenCalled();
  });
});
