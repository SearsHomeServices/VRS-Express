// Tyler 2026-05-01: Server-side cache + persistence for the admin-configurable
// VRS business hours. Stored as JSON in `system_settings` under key
// `vrs_business_hours` (no schema change required — system_settings is a
// generic key/value table).
//
// Two profiles: `default` (most submissions) and `hvac` (HVAC tickets, which
// have narrower hours per Tyler — Mon-Fri 8a-5:30p ET vs Mon-Sat 8a-8p ET).
// Discriminator: `submission.applianceType === "hvac"` → hvac profile, else
// default. See `categoryForApplianceType` in shared/business-hours.ts.
//
// Cache lifecycle: warmed at server startup via `loadConfig()`, refreshed
// on every `PUT /api/business-hours` via `invalidate()`. Single-process
// container so no inter-process coordination needed.

import { storage } from "./storage";
import {
  type BusinessHoursConfig,
  type BusinessHoursProfile,
  DEFAULT_BUSINESS_HOURS_CONFIG,
  ALL_DAYS,
  type DayKey,
} from "@shared/business-hours";

export const BUSINESS_HOURS_SETTING_KEY = "vrs_business_hours";

let cachedConfig: BusinessHoursConfig = DEFAULT_BUSINESS_HOURS_CONFIG;
let loaded = false;

// Validates a profile shape coming from JSON storage. Returns null if invalid
// so the caller can fall back to defaults rather than crash.
// Tyler 2026-05-01 (architect fix): aligned with PUT zod schema —
// HH:MM format AND close > open AND openDays non-empty. Previously any
// out-of-band edit to system_settings could push an invalid config into
// the cache (e.g. close before open).
function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
function validateProfile(p: unknown): BusinessHoursProfile | null {
  if (!p || typeof p !== "object") return null;
  const obj = p as Record<string, unknown>;
  const open = obj.open;
  const close = obj.close;
  const openDays = obj.openDays;
  if (typeof open !== "string" || typeof close !== "string") return null;
  const openMin = hhmmToMinutes(open);
  const closeMin = hhmmToMinutes(close);
  if (openMin === null || closeMin === null) return null;
  if (closeMin <= openMin) return null;
  if (!Array.isArray(openDays) || openDays.length === 0) return null;
  const days: DayKey[] = [];
  for (const d of openDays) {
    if (typeof d !== "string") return null;
    if (!ALL_DAYS.includes(d as DayKey)) return null;
    days.push(d as DayKey);
  }
  return { open, close, openDays: days };
}

function validateConfig(raw: unknown): BusinessHoursConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const def = validateProfile(obj.default);
  const hvac = validateProfile(obj.hvac);
  if (!def || !hvac) return null;
  return { default: def, hvac };
}

// Load from DB and populate cache. Safe to call multiple times. Falls back
// to DEFAULT_BUSINESS_HOURS_CONFIG on missing row, malformed JSON, or
// schema validation failure (with a console.warn so Tyler can see why).
export async function loadConfig(): Promise<BusinessHoursConfig> {
  try {
    const raw = await storage.getSystemSetting(BUSINESS_HOURS_SETTING_KEY);
    if (!raw) {
      cachedConfig = DEFAULT_BUSINESS_HOURS_CONFIG;
      loaded = true;
      return cachedConfig;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(
        `[business-hours-config] system_settings.${BUSINESS_HOURS_SETTING_KEY} is not valid JSON; using defaults.`,
      );
      cachedConfig = DEFAULT_BUSINESS_HOURS_CONFIG;
      loaded = true;
      return cachedConfig;
    }
    const valid = validateConfig(parsed);
    if (!valid) {
      console.warn(
        `[business-hours-config] system_settings.${BUSINESS_HOURS_SETTING_KEY} failed validation; using defaults.`,
      );
      cachedConfig = DEFAULT_BUSINESS_HOURS_CONFIG;
      loaded = true;
      return cachedConfig;
    }
    cachedConfig = valid;
    loaded = true;
    return cachedConfig;
  } catch (err) {
    // Tyler 2026-05-01 (architect fix): do NOT pin loaded=true on hard
    // DB errors. A transient startup failure used to lock the runtime
    // onto defaults until process restart. Now the next read retries.
    console.error("[business-hours-config] load failed (will retry):", err);
    if (!loaded) {
      cachedConfig = DEFAULT_BUSINESS_HOURS_CONFIG;
    }
    return cachedConfig;
  }
}

// Synchronous read of the current cached config. Returns DEFAULT until
// `loadConfig()` resolves at startup. All hot-path SMS/timer code uses this
// — never hits the DB.
export function getCachedConfig(): BusinessHoursConfig {
  return cachedConfig;
}

export function getCachedProfile(category: "default" | "hvac"): BusinessHoursProfile {
  return category === "hvac" ? cachedConfig.hvac : cachedConfig.default;
}

// Persist a new config to DB and refresh cache. Caller is responsible for
// validating + authorizing. Returns the saved config.
export async function saveConfig(config: BusinessHoursConfig): Promise<BusinessHoursConfig> {
  await storage.setSystemSetting(BUSINESS_HOURS_SETTING_KEY, JSON.stringify(config));
  cachedConfig = config;
  loaded = true;
  return cachedConfig;
}

// Force a re-read from DB. Used if another process / admin updated the row
// out-of-band. In normal operation `saveConfig` already updates the cache.
export async function invalidate(): Promise<BusinessHoursConfig> {
  return loadConfig();
}

export function isLoaded(): boolean {
  return loaded;
}
