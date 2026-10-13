import { createHmac, timingSafeEqual } from "crypto";
import type { DirectAhsPayload } from "../../shared/direct-ahs";

export class DirectAhsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface DirectAhsConfig { origin: string; apiKey: string; callbackUrl: string; webhookSecret: string }
export function directAhsConfig(env: NodeJS.ProcessEnv): DirectAhsConfig | null {
  if (env.DIRECT_AHS_AI_ENABLED !== "true") return null;
  try {
    const url = new URL(env.DIRECT_AHS_AI_BASE_URL ?? "");
    const callback = new URL(env.DIRECT_AHS_AI_CALLBACK_URL ?? "");
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password ||
        callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash ||
        callback.pathname !== "/api/integrations/direct-ahs/v1/result" ||
        !env.DIRECT_AHS_AI_API_KEY || !env.DIRECT_AHS_AI_WEBHOOK_SECRET) return null;
    return { origin: url.origin, apiKey: env.DIRECT_AHS_AI_API_KEY, callbackUrl: callback.href, webhookSecret: env.DIRECT_AHS_AI_WEBHOOK_SECRET };
  } catch { return null; }
}

/** Dedicated auth and wire contract: never uses Sasha keys, endpoints or callbacks. */
export function verifyDirectAhsSignature(raw: Buffer, timestamp: string, signature: string, secret: string, now = Date.now()) {
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

export async function sendDirectAhs(payload: DirectAhsPayload, config: DirectAhsConfig, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${config.origin}/api/direct-ahs/v1/authorize`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey, "Idempotency-Key": payload.requestId },
    body: JSON.stringify(payload),
  });
  // Every non-acknowledged send is ambiguous. Do not invent a rejection or
  // launch a second call: retry the SAME immutable payload/idempotency key.
  if (response.status !== 200 && response.status !== 202) throw new Error(`AI did not acknowledge the request (HTTP ${response.status})`);
  const result = await response.json();
  if (result.requestId !== payload.requestId || typeof result.callId !== "string" ||
      !result.callId.trim() || result.callId.length > 100 || result.status !== "accepted") {
    throw new Error("AI returned an invalid acknowledgment");
  }
  return result.callId as string;
}
