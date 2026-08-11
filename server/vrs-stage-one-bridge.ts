import type {
  DispatchVrsAiResult,
  VrsAiClient,
  VrsAuthorizeEnrichment,
  VrsBridgeStore,
} from "./vrs-sasha-queue";

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
