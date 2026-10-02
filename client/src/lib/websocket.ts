import { useEffect, useRef, useCallback } from "react";
import { getToken } from "./auth";

type WSEventHandler = (payload: any) => void;

const handlers = new Map<string, Set<WSEventHandler>>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// Tyler 2026-05-26 / revised 2026-06-27 — zombie WebSocket detection.
// Some users behind corporate proxies hit a failure where the underlying
// TCP connection dies WITHOUT the browser ever firing `onclose`: the
// browser keeps `readyState === OPEN` while no data flows. We must still
// detect that and reconnect.
//
// BUT the original 45s threshold turned into a false-positive engine. Prod
// telemetry showed ~9k reconnects/day, 99.96% desktop, reconnect < 3s —
// i.e. healthy sockets being torn down, not dead ones. Root cause: a
// backgrounded tab's keepalive setInterval is throttled by the browser to
// ~60s, so the first tick after un-throttling measured ~59s of "idle" and
// killed a perfectly healthy socket. Switching the prod VM could not fix
// it because the bug is entirely client-side.
//
// The defenses below preserve genuine dead-socket detection while removing
// the false positives:
//   1) The server now pushes an app-level {type:"hb"} data frame every
//      ~25s (server/websocket.ts), which DOES surface to onmessage and
//      refreshes lastInboundAt — unlike a protocol ping. A live socket is
//      therefore never idle longer than ~25-30s.
//   2) Widened the idle threshold to 80s (tolerates two missed heartbeats)
//      and require MAX_FAILED_PROBES consecutive over-threshold ticks
//      before declaring death — one slow tick is noise.
//   3) Skip the idle verdict entirely when the tab is hidden or the tick
//      fired late (throttled timer): the measurement is an artifact then.
//   4) On refocus, PROBE the socket instead of tearing it down, and
//      rate-limit forced reconnects so event bursts can't storm.
const ZOMBIE_INBOUND_TIMEOUT_MS = 80000;
const KEEPALIVE_INTERVAL_MS = 20000;
// A keepalive tick that fires more than this late means the browser
// throttled our timer (backgrounded tab). The idle window measured on such
// a tick is meaningless, so we treat it as a probe, not a death verdict.
const LATE_TICK_GRACE_MS = KEEPALIVE_INTERVAL_MS * 2;
// Require this many CONSECUTIVE over-threshold ticks before reconnecting.
const MAX_FAILED_PROBES = 2;
// Floor on how often visibility/focus/online events may force a reconnect,
// so alt-tabbing can't create a connect storm.
const MIN_FORCED_RECONNECT_INTERVAL_MS = 10000;
let lastInboundAt = Date.now();
let lastKeepaliveTickAt = Date.now();
let failedProbes = 0;
let lastForcedReconnectAt = 0;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

// Tyler 2026-05-26 — WS telemetry. Posts to HTTP (not WS, since the
// whole point is to phone home when the WS is broken). Fire-and-forget,
// best-effort — telemetry failure never blocks reconnect logic.
let lastDisconnectAt = 0;
function postTelemetry(event: string, details: Record<string, unknown>) {
  const token = getToken();
  if (!token) return;
  try {
    fetch("/api/agent/ws-telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ event, details }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

function isZombieSocket(): boolean {
  if (!ws) return false;
  return Date.now() - lastInboundAt > ZOMBIE_INBOUND_TIMEOUT_MS;
}

function killZombieAndReconnect(reason: string) {
  console.warn(`[ws] Reconnecting — ${reason}`);
  postTelemetry("ws_zombie_detected", {
    reason: reason.slice(0, 120),
    idleMs: Date.now() - lastInboundAt,
  });
  if (!lastDisconnectAt) lastDisconnectAt = Date.now();
  // Stop keepalive BEFORE we null out ws so the next tick doesn't fire
  // against a stale reference. The replaced socket's late onclose is
  // already guarded by the `ws !== socket` check inside connect().
  stopKeepalive();
  if (ws) {
    const dead = ws;
    ws = null;
    try { dead.close(); } catch {}
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connect();
}

function startKeepalive() {
  if (keepaliveTimer) return;
  lastKeepaliveTickAt = Date.now();
  failedProbes = 0;
  keepaliveTimer = setInterval(() => {
    if (!ws) return;
    const now = Date.now();
    const sinceLastTick = now - lastKeepaliveTickAt;
    lastKeepaliveTickAt = now;

    // If the tab is hidden OR this tick fired far later than scheduled, the
    // browser throttled our timer. Any idle window measured now is an
    // artifact, not evidence the socket died — skip the verdict, send a
    // probe, and let the next un-throttled tick judge. This is the single
    // biggest source of the false-positive reconnects we removed.
    const throttled =
      (typeof document !== "undefined" && document.hidden) ||
      sinceLastTick > LATE_TICK_GRACE_MS;

    if (!throttled) {
      if (isZombieSocket()) {
        failedProbes++;
        if (failedProbes >= MAX_FAILED_PROBES) {
          killZombieAndReconnect(
            `no inbound for ${Math.round((now - lastInboundAt) / 1000)}s over ${failedProbes} probes`,
          );
          return;
        }
      } else {
        failedProbes = 0;
      }
    }

    // Always exercise the outbound path while OPEN. The send doubles as our
    // probe: a dead outbound socket throws synchronously here, which is an
    // immediate, unambiguous death signal (no grace needed).
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "ping", t: now }));
      } catch (e) {
        killZombieAndReconnect(`ping send threw: ${e}`);
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function getWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = getToken();
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token || "")}`;
}

function connect() {
  const token = getToken();
  if (!token) return;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    // Tyler 2026-05-26 — capture the socket instance so handlers can
    // verify they're still the active socket. Without this, a late
    // `onclose` from a socket we already replaced (e.g. in
    // killZombieAndReconnect) clobbers the new socket's global state:
    // sets `ws=null`, stops keepalive on the live socket, and schedules
    // an extra reconnect on top of the new connection. Each handler
    // early-returns if it isn't the current ws.
    const socket = new WebSocket(getWsUrl());
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      // If this open follows a disconnect, emit reconnect telemetry so
      // we can see in admin tooling who's churning their WS often.
      if (reconnectAttempts > 0 || lastDisconnectAt > 0) {
        postTelemetry("ws_reconnect_success", {
          attempts: reconnectAttempts,
          downtimeMs: lastDisconnectAt ? Date.now() - lastDisconnectAt : 0,
        });
      }
      lastDisconnectAt = 0;
      reconnectAttempts = 0;
      lastInboundAt = Date.now();
      startKeepalive();
      console.log("[ws] Connected");
    };

    socket.onmessage = (event) => {
      if (ws !== socket) return;
      // Any inbound frame proves the socket is alive — refresh the clock and
      // clear the failed-probe counter so a prior slow tick can't carry over.
      lastInboundAt = Date.now();
      failedProbes = 0;
      try {
        const data = JSON.parse(event.data);
        // pong = reply to our keepalive ping; hb = server app-level
        // heartbeat. Both exist only to keep the inbound clock fresh and are
        // never dispatched to handlers.
        if (data.type === "pong" || data.type === "hb") return;
        if (data.type) {
          const typeHandlers = handlers.get(data.type);
          if (typeHandlers) {
            typeHandlers.forEach((handler) => handler(data.payload));
          }
        }
      } catch {}
    };

    socket.onclose = (event) => {
      // Stale onclose from a socket we already replaced — ignore it
      // entirely. killZombieAndReconnect() already handled cleanup
      // and started a new connect; we must not stop keepalive or
      // schedule a duplicate reconnect on the live socket's behalf.
      if (ws !== socket) return;
      ws = null;
      stopKeepalive();
      lastDisconnectAt = Date.now();
      // Auth-related close codes (4000-4003) are clean: 4000 = user
      // logout, 4001/4002/4003 = auth failure. 1000/1001 are clean
      // browser close. Anything else is unexpected and worth telemetry.
      const isAuthClose = event.code === 4000 || event.code === 4001 || event.code === 4002 || event.code === 4003;
      const isCleanClose = event.code === 1000 || event.code === 1001;
      if (!isAuthClose && !isCleanClose) {
        postTelemetry("ws_unexpected_close", { code: event.code });
      }
      if (!isAuthClose) {
        scheduleReconnect();
      }
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      try { socket.close(); } catch {}
    };
  } catch {}
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const token = getToken();
    if (token) {
      connect();
    }
  }, delay);
}

// Tyler 2026-05-15 / revised 2026-06-27 — when the tab regains focus, the
// network comes back, or the browser unhides the tab, make sure we have a
// live socket WITHOUT reflexively tearing down a healthy one. The old
// version called killZombieAndReconnect on sight if the inbound clock
// looked stale — but after a hidden stretch a perfectly healthy socket's
// clock is legitimately stale, so that path was itself a churn source.
// Now we PROBE an open socket (the server's pong/hb refreshes the clock)
// and only reconnect when the socket is actually gone, rate-limited so a
// burst of focus/visibility/online events can't create a connect storm.
function forceReconnectIfDead() {
  const token = getToken();
  if (!token) return;

  // A still-connecting socket just needs time — never disturb it.
  if (ws && ws.readyState === WebSocket.CONNECTING) return;

  // Open socket: probe, don't tear down. Reset the tick clock so the
  // resumed keepalive interval isn't misread as a throttled late tick.
  if (ws && ws.readyState === WebSocket.OPEN) {
    lastKeepaliveTickAt = Date.now();
    failedProbes = 0;
    try {
      ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
      return; // alive — keep it, await the pong/next hb
    } catch {
      // send threw — the outbound socket is genuinely dead. Tear down and
      // reconnect immediately (this is a real death, not a focus burst).
      const dead = ws;
      ws = null;
      stopKeepalive();
      try { dead.close(); } catch {}
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
      return;
    }
  }

  // No usable socket (closed/closing/null). onclose has normally already
  // armed a backoff reconnect; we just accelerate it. Rate-limit so a burst
  // of visibility/focus/online events can't create a connect storm. We do
  // NOT reset reconnectAttempts — that happens on a successful onopen.
  const now = Date.now();
  if (now - lastForcedReconnectAt < MIN_FORCED_RECONNECT_INTERVAL_MS) return;
  lastForcedReconnectAt = now;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connect();
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") forceReconnectIfDead();
  });
  window.addEventListener("focus", forceReconnectIfDead);
  window.addEventListener("online", forceReconnectIfDead);
}

export function disconnectWs() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopKeepalive();
  reconnectAttempts = 0;
  if (ws) {
    ws.close(4000, "User logout");
    ws = null;
  }
}

export function connectWs() {
  connect();
}

export function onWsEvent(type: string, handler: WSEventHandler) {
  if (!handlers.has(type)) {
    handlers.set(type, new Set());
  }
  handlers.get(type)!.add(handler);
  return () => {
    const typeHandlers = handlers.get(type);
    if (typeHandlers) {
      typeHandlers.delete(handler);
      if (typeHandlers.size === 0) {
        handlers.delete(type);
      }
    }
  };
}

let audioCtx: AudioContext | null = null;
let audioUnlocked = false;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioCtx;
}

let removeUnlockListeners: (() => void) | null = null;

function unlockAudio() {
  if (audioUnlocked) return;
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") {
      ctx.resume().then(() => {
        audioUnlocked = true;
        if (removeUnlockListeners) {
          removeUnlockListeners();
          removeUnlockListeners = null;
        }
      }).catch(() => {});
    } else {
      audioUnlocked = true;
      if (removeUnlockListeners) {
        removeUnlockListeners();
        removeUnlockListeners = null;
      }
    }
  } catch {}
}

if (typeof window !== "undefined") {
  const events = ["click", "touchstart", "keydown"];
  const handler = () => {
    unlockAudio();
  };
  events.forEach(e => document.addEventListener(e, handler, true));
  removeUnlockListeners = () => {
    events.forEach(e => document.removeEventListener(e, handler, true));
  };
}

export type ToneId = "chime" | "bell" | "pulse" | "cascade" | "alert";

export const TONE_OPTIONS: { id: ToneId; label: string }[] = [
  { id: "chime", label: "Chime" },
  { id: "bell", label: "Bell" },
  { id: "pulse", label: "Pulse" },
  { id: "cascade", label: "Cascade" },
  { id: "alert", label: "Alert" },
];

let cachedTone: ToneId = "chime";
let cachedVolume = 0.5;
let settingsLoaded = false;

export async function loadNotificationSettings(options?: { requireSuccess?: boolean }): Promise<{ tone: ToneId; volume: number }> {
  try {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch("/api/settings/notification-tone", { headers });
    if (res.ok) {
      const data = await res.json();
      cachedTone = TONE_OPTIONS.some(o => o.id === data.tone) ? data.tone : "chime";
      cachedVolume = typeof data.volume === "number" ? data.volume : 0.5;
      settingsLoaded = true;
    } else if (options?.requireSuccess) {
      throw new Error("Notification settings unavailable");
    }
  } catch (error) {
    if (options?.requireSuccess) throw error;
  }
  return { tone: cachedTone, volume: cachedVolume };
}

export function getNotificationVolume(): number {
  return cachedVolume;
}

export function getSelectedTone(): ToneId {
  return cachedTone;
}

export function setCachedVolume(vol: number) {
  cachedVolume = Math.max(0, Math.min(1, vol));
}

export function setCachedTone(tone: ToneId) {
  cachedTone = tone;
}

if (!settingsLoaded) {
  loadNotificationSettings();
}

type TonePlayer = (ctx: AudioContext, volume: number) => void;

const tonePlayersMap: Record<ToneId, TonePlayer> = {
  chime: (ctx, vol) => {
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(vol * 0.5, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    const o1 = ctx.createOscillator();
    o1.type = "sine";
    o1.frequency.setValueAtTime(880, now);
    o1.frequency.setValueAtTime(1100, now + 0.1);
    o1.connect(g);
    o1.start(now);
    o1.stop(now + 0.6);

    const g2 = ctx.createGain();
    g2.connect(ctx.destination);
    g2.gain.setValueAtTime(0.001, now);
    g2.gain.setValueAtTime(vol * 0.4, now + 0.15);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    const o2 = ctx.createOscillator();
    o2.type = "sine";
    o2.frequency.value = 1320;
    o2.connect(g2);
    o2.start(now + 0.15);
    o2.stop(now + 0.6);
  },

  bell: (ctx, vol) => {
    const now = ctx.currentTime;
    const freqs = [523, 659, 784, 1047];
    const amps = [0.4, 0.25, 0.2, 0.15];
    freqs.forEach((freq, i) => {
      const g = ctx.createGain();
      g.connect(ctx.destination);
      g.gain.setValueAtTime(vol * amps[i], now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = freq;
      o.connect(g);
      o.start(now);
      o.stop(now + 0.8);
    });
  },

  pulse: (ctx, vol) => {
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(vol * 0.4, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = 660;
    o.connect(g);
    o.start(now);
    o.stop(now + 0.7);

    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = "sine";
    lfo.frequency.value = 4;
    lfoGain.gain.value = vol * 0.2;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    lfo.start(now);
    lfo.stop(now + 0.7);
  },

  cascade: (ctx, vol) => {
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(vol * 0.5, now + 0.15);
    g.gain.setValueAtTime(vol * 0.5, now + 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(400, now);
    o.frequency.linearRampToValueAtTime(1600, now + 0.6);
    o.connect(g);
    o.start(now);
    o.stop(now + 0.6);
  },

  alert: (ctx, vol) => {
    const now = ctx.currentTime;
    const freqs = [784, 988, 1175, 988];
    freqs.forEach((freq, i) => {
      const start = now + i * 0.15;
      const g = ctx.createGain();
      g.connect(ctx.destination);
      g.gain.setValueAtTime(vol * 0.5, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = freq;
      o.connect(g);
      o.start(start);
      o.stop(start + 0.15);
    });
  },
};

function playToneWithWebAudio(tone: ToneId, volume: number) {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") {
      ctx.resume().then(() => {
        tonePlayersMap[tone](ctx, volume);
      }).catch((err) => {
        console.warn("[notification] AudioContext resume failed:", err);
      });
    } else {
      tonePlayersMap[tone](ctx, volume);
    }
  } catch (e) {
    console.warn("[notification] Web Audio error:", e);
  }
}

export function playNotificationDing() {
  playToneWithWebAudio(cachedTone, cachedVolume);
}

// Reserved for Pilot queue wait alerts, distinct from every selectable tone.
export function playPilotQueueChime() {
  if (cachedVolume <= 0) return;
  try {
    const ctx = getAudioContext();
    const play = () => {
      if (cachedVolume <= 0) return;
      [1047, 784, 1319].forEach((frequency, index) => {
        const start = ctx.currentTime + index * 0.22;
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(cachedVolume * 0.3, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
        const oscillator = ctx.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        oscillator.start(start);
        oscillator.stop(start + 0.2);
      });
    };
    if (ctx.state === "suspended") {
      void ctx.resume().then(play).catch(error => console.warn("[notification] Pilot audio resume failed:", error));
    } else play();
  } catch (error) {
    console.warn("[notification] Pilot audio failed:", error);
  }
}

export function playTonePreview(tone: ToneId) {
  playToneWithWebAudio(tone, cachedVolume);
}

export function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export function showBrowserNotification(title: string, body?: string) {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const tag = `vrs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const n = new Notification(title, {
        body,
        icon: "/favicon.ico",
        tag,
        requireInteraction: false,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      setTimeout(() => n.close(), 15000);
    } catch {}
  }
}

export function useWebSocket(role?: string) {
  const isConnected = useRef(false);

  useEffect(() => {
    if (!role || (role !== "vrs_agent" && role !== "admin" && role !== "super_admin" && role !== "technician")) {
      return;
    }

    const token = getToken();
    if (!token) return;

    if (!isConnected.current) {
      connectWs();
      isConnected.current = true;
    }

    return () => {
    };
  }, [role]);

  const subscribe = useCallback((type: string, handler: WSEventHandler) => {
    return onWsEvent(type, handler);
  }, []);

  return { subscribe };
}
