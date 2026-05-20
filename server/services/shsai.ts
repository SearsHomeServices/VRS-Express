import crypto from "crypto";

// Tyler 2026-05-20: migrated off the Telluride-hosted UAT API
// (ais.tellurideplatform.com, started returning 403 on 2026-05-09) onto the
// new Sears-hosted prod SHSAI service. Path structure /tell/api/hs/routing/v1
// is unchanged; only the host moved. New host discovered by inspecting the
// JS bundle served by https://shsai-routing-ui.prod.nextgen.shs.com — the
// UI compiles in shsai-routing-assist.prod.nextgen.shs.com as the API base.
const SHSAI_BASE_URL = "https://shsai-routing-assist.prod.nextgen.shs.com/tell/api/hs/routing/v1";

function generateTrackId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateDeviceInfo(): string {
  const uuid = crypto.randomUUID();
  return `${uuid}~~Server~~nodejs~~VRS~~1`;
}

export interface ShsaiSession {
  trackId: string;
  sessionId: string;
  threadId: string;
  deviceInfo: string;
}

export async function initSession(agentUserId: string): Promise<ShsaiSession> {
  const trackId = generateTrackId();
  const deviceInfo = generateDeviceInfo();

  const response = await fetch(`${SHSAI_BASE_URL}/init`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "deviceinfo": deviceInfo,
    },
    body: JSON.stringify({
      chat_bot_type: "HS_ROUTE_ASSISTANT",
      trackId,
      parameters: {
        userId: agentUserId,
        techId: "",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`SHSAI init failed: ${response.status} ${response.statusText}`);
  }

  const sessionId = response.headers.get("sessionid");
  const data = await response.json();

  return {
    trackId,
    sessionId: sessionId || data.session_id || data.sessionId || "",
    threadId: data.thread_id || data.threadId || "",
    deviceInfo,
  };
}

async function sseAssist(
  session: ShsaiSession,
  userMessage: string
): Promise<string> {
  const response = await fetch(`${SHSAI_BASE_URL}/sse/assist`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "deviceinfo": session.deviceInfo,
      "sessionid": session.sessionId,
    },
    body: JSON.stringify({
      chat_bot_type: "HS_ROUTE_ASSISTANT",
      trackId: session.trackId,
      thread_id: session.threadId,
      parameters: {
        userMessage,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`SHSAI sse/assist failed: ${response.status} - ${errorBody}`);
  }

  const text = await response.text();
  const chunks = text.split("\n").filter((line) => line.trim());
  let fullContent = "";

  for (const chunk of chunks) {
    try {
      const parsed = JSON.parse(chunk);
      if (parsed.type === "TEXT") {
        fullContent += parsed.content;
      }
      if (parsed.type === "STATUS" && parsed.content === "COMPLETE") {
        break;
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return fullContent;
}

export async function queryServiceOrder(
  agentUserId: string,
  serviceOrder: string
): Promise<{ session: ShsaiSession; content: string }> {
  const session = await initSession(agentUserId);
  const soNumber = serviceOrder.includes("-") ? serviceOrder.split("-").pop()! : serviceOrder;
  const prompt = `Give me all orders for customer having sample service order number ${soNumber}`;
  const content = await sseAssist(session, prompt);
  return { session, content };
}

export async function sendFollowup(
  session: ShsaiSession,
  message: string
): Promise<string> {
  return await sseAssist(session, message);
}
