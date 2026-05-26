import { useEffect, useRef, useCallback } from "react";
import { getToken } from "./auth";

type WSEventHandler = (payload: any) => void;

const handlers = new Map<string, Set<WSEventHandler>>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// Tyler 2026-05-26 — zombie WebSocket detection. Jeff Van Ness (and
// likely others behind corporate proxies) hit a class of failure where
// the underlying TCP connection dies WITHOUT the browser ever firing
// `onclose`. The browser keeps `readyState === OPEN` while no data
// flows. Server-side the 25s heartbeat terminates the dead socket and
// 60 min later fires `presence_stale_cleanup` — flipping the agent to
// offline even though the dashboard still shows "Available". Real-time
// alerts silently stop flowing the whole time.
//
// Three defenses, all needed:
//   1) Track inbound activity. If nothing arrives for > ZOMBIE_TIMEOUT
//      (45s, > server's 25s heartbeat), the socket is dead regardless
//      of what readyState says.
//   2) Send our own app-level ping every 20s. The SEND itself exercises
//      the outbound path — a zombie socket throws synchronously on
//      ws.send(), which we catch and treat as dead.
//   3) Update forceReconnectIfDead() to consult the inbound timestamp
//      instead of trusting readyState alone.
const ZOMBIE_INBOUND_TIMEOUT_MS = 45000;
const KEEPALIVE_INTERVAL_MS = 20000;
let lastInboundAt = Date.now();
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
  keepaliveTimer = setInterval(() => {
    if (!ws) return;
    if (isZombieSocket()) {
      killZombieAndReconnect(`no inbound for ${Math.round((Date.now() - lastInboundAt) / 1000)}s`);
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
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
      lastInboundAt = Date.now();
      try {
        const data = JSON.parse(event.data);
        if (data.type === "pong") return;
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

// Tyler 2026-05-15 — when the tab regains focus, the network comes back,
// or the browser unhides the tab, force an immediate reconnect instead
// of waiting for the next backoff tick. Browsers throttle setTimeout to
// ~1/min in background tabs, so a socket that died while backgrounded
// could take minutes to retry on its own — long enough to trip the
// server's auto-offline grace and flip the agent to offline. This
// closes that gap.
function forceReconnectIfDead() {
  const token = getToken();
  if (!token) return;
  // Zombie check first — a socket with readyState OPEN may still be dead
  // if no inbound traffic has flowed past our zombie threshold. Trusting
  // readyState alone is exactly what let Jeff's case slip through.
  if (ws && isZombieSocket()) {
    killZombieAndReconnect("forceReconnect detected zombie");
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  // Cancel any pending backoff and try right now, but DO NOT reset
  // reconnectAttempts — that's reset on successful ws.onopen. If the
  // server is genuinely unreachable, the next failed attempt will fall
  // back into the exponential backoff and we won't create a connect
  // storm from repeated visibility/focus events.
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

export async function loadNotificationSettings(): Promise<{ tone: ToneId; volume: number }> {
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
    }
  } catch {}
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
