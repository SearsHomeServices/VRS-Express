import type {
  DispatchVrsAiResult,
  VrsAiClient,
  VrsAuthorizeEnrichment,
  VrsBridgeStore,
} from "./vrs-sasha-queue";
import { isValidVrsExpressCallbackUrl } from "./vrs-sasha-contract";

export type VrsStageOneBridgeResult =
  | { kind: "not_applicable" }
  | { kind: "accepted"; dispatch: DispatchVrsAiResult }
  | {
      kind: "http_error";
      status: 409 | 429 | 502 | 503;
      code: string;
      message: string;
    };

export interface VrsStageOneBridgeConfig {
  baseUrl: string;
  apiKey: string;
  callbackUrl: string;
  callbackSecret: string;
}

type VrsStageOneEnvironment = Readonly<Record<string, string | undefined>>;

export type VrsAiBridgeActivation =
  | { kind: "active"; config: VrsStageOneBridgeConfig }
  | {
      kind: "disabled" | "invalid";
      code: "VRS_AI_BRIDGE_DISABLED" | "VRS_AI_BRIDGE_NOT_CONFIGURED";
      message: string;
    };

export function resolveVrsAiBridgeActivation(
  env: VrsStageOneEnvironment,
): VrsAiBridgeActivation {
  if (
    env.NODE_ENV === "production" &&
    env.VRS_AI_PRODUCTION_ENABLED !== "true"
  ) {
    return {
      kind: "disabled",
      code: "VRS_AI_BRIDGE_DISABLED",
      message:
        "VRS AI bridge intake is disabled in production. Set VRS_AI_PRODUCTION_ENABLED=true only after the outbound bridge and callback are fully configured.",
    };
  }

  const baseUrl = env.VRS_AI_BASE_URL?.trim();
  const apiKey =
    env.VRS_AI_API_KEY?.trim() ||
    (env.NODE_ENV === "development"
      ? env.VRS_SASHA_API_KEY?.trim()
      : undefined);
  const callbackSecret = env.VRS_AI_WEBHOOK_SECRET?.trim();
  let callbackUrl = env.VRS_AI_CALLBACK_URL?.trim();
  let publicCallbackUrl: string | undefined;
  if (env.VRS_EXPRESS_PUBLIC_URL) {
    try {
      publicCallbackUrl = new URL(
        "/api/integrations/vrs-ai/v1/webhook",
        env.VRS_EXPRESS_PUBLIC_URL,
      ).toString();
    } catch {
      publicCallbackUrl = undefined;
    }
  }
  callbackUrl ||= publicCallbackUrl;

  let validBaseUrl = false;
  if (baseUrl) {
    try {
      const parsedBaseUrl = new URL(baseUrl);
      validBaseUrl =
        parsedBaseUrl.protocol === "https:" &&
        !parsedBaseUrl.username &&
        !parsedBaseUrl.password &&
        !parsedBaseUrl.search &&
        !parsedBaseUrl.hash &&
        parsedBaseUrl.pathname === "/";
    } catch {
      validBaseUrl = false;
    }
  }

  if (
    !validBaseUrl ||
    !apiKey ||
    !callbackSecret ||
    callbackSecret.length < 16 ||
    callbackSecret.length > 512 ||
    !callbackUrl ||
    !isValidVrsExpressCallbackUrl(callbackUrl) ||
    (env.NODE_ENV === "production" &&
      (!publicCallbackUrl || callbackUrl !== publicCallbackUrl))
  ) {
    return {
      kind: "invalid",
      code: "VRS_AI_BRIDGE_NOT_CONFIGURED",
      message:
        "VRS AI bridge intake is unavailable because the outbound bridge or callback configuration is incomplete or invalid.",
    };
  }

  return {
    kind: "active",
    config: { baseUrl: baseUrl!, apiKey, callbackUrl, callbackSecret },
  };
}

export function resolveVrsStageOneBridgeConfig(
  env: VrsStageOneEnvironment,
): VrsStageOneBridgeConfig | undefined {
  const activation = resolveVrsAiBridgeActivation(env);
  return activation.kind === "active" ? activation.config : undefined;
}

type VrsStageOneBridgeStore = Pick<
  VrsBridgeStore,
  | "getBySubmissionId"
  | "markDispatching"
  | "markAccepted"
  | "markDispatchFailed"
>;

type VrsStageOneDispatcher = (options: {
  submissionId: number;
  store: VrsStageOneBridgeStore;
  client: VrsAiClient;
  callbackUrl: string;
  callbackSecret: string;
  enrichment?: VrsAuthorizeEnrichment;
  signObjectPhotoUrl?: (objectPath: string) => Promise<string>;
}) => Promise<DispatchVrsAiResult>;

export interface VrsStageOneBridgeOptions {
  submissionId: number;
  store: VrsStageOneBridgeStore;
  resolveConfig: () => VrsStageOneBridgeConfig | undefined;
  createClient: (config: VrsStageOneBridgeConfig) => VrsAiClient;
  dispatch: VrsStageOneDispatcher;
  resolveEnrichment?: () =>
    | VrsAuthorizeEnrichment
    | undefined
    | Promise<VrsAuthorizeEnrichment | undefined>;
  signObjectPhotoUrl?: (objectPath: string) => Promise<string>;
}

export async function decideVrsStageOneBridge(
  options: VrsStageOneBridgeOptions,
): Promise<VrsStageOneBridgeResult> {
  const bridge = await options.store.getBySubmissionId(options.submissionId);
  if (!bridge) return { kind: "not_applicable" };

  const config = options.resolveConfig();
  if (!config) {
    return {
      kind: "http_error",
      status: 503,
      code: "VRS_AI_NOT_CONFIGURED",
      message:
        "VRS AI bridge is not configured. Set VRS_AI_BASE_URL, VRS_AI_API_KEY, VRS_AI_WEBHOOK_SECRET, and VRS_AI_CALLBACK_URL (or VRS_EXPRESS_PUBLIC_URL).",
    };
  }

  const client = options.createClient(config);
  const enrichment = await options.resolveEnrichment?.();
  const dispatch = await options.dispatch({
    submissionId: options.submissionId,
    store: {
      getBySubmissionId: async () => bridge,
      markDispatching: options.store.markDispatching.bind(options.store),
      markAccepted: options.store.markAccepted.bind(options.store),
      markDispatchFailed: options.store.markDispatchFailed.bind(options.store),
    },
    client,
    callbackUrl: config.callbackUrl,
    callbackSecret: config.callbackSecret,
    enrichment,
    signObjectPhotoUrl: options.signObjectPhotoUrl,
  });

  if (dispatch.kind === "busy") {
    return {
      kind: "http_error",
      status: 409,
      code: "VRS_AI_DISPATCH_IN_PROGRESS",
      message:
        "This ticket is already being sent to VRS AI. Wait a moment and refresh.",
    };
  }
  if (dispatch.kind === "failed") {
    return {
      kind: "http_error",
      status: dispatch.status === 429 ? 429 : 502,
      code: "VRS_AI_DISPATCH_FAILED",
      message: dispatch.message,
    };
  }
  if (dispatch.kind === "not_applicable") {
    return { kind: "not_applicable" };
  }

  return { kind: "accepted", dispatch };
}

type VrsStageOneHttpError = Extract<
  VrsStageOneBridgeResult,
  { kind: "http_error" }
>;

export async function runVrsStageOneRouteGate(
  options: VrsStageOneBridgeOptions,
  respond: (
    error: VrsStageOneHttpError,
  ) => unknown | Promise<unknown>,
): Promise<"continue" | "responded"> {
  const result = await decideVrsStageOneBridge(options);
  if (result.kind !== "http_error") return "continue";

  await respond(result);
  return "responded";
}
