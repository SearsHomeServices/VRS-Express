import { useEffect, useRef, useCallback } from "react";
import { getToken } from "./auth";

type WSEventHandler = (payload: any) => void;

const handlers = new Map<string, Set<WSEventHandler>>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

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
    ws = new WebSocket(getWsUrl());

    ws.onopen = () => {
      reconnectAttempts = 0;
      console.log("[ws] Connected");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type) {
          const typeHandlers = handlers.get(data.type);
          if (typeHandlers) {
            typeHandlers.forEach((handler) => handler(data.payload));
          }
        }
      } catch {}
    };

    ws.onclose = (event) => {
      ws = null;
      if (event.code !== 4000 && event.code !== 4001 && event.code !== 4002 && event.code !== 4003) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (ws) {
        ws.close();
      }
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
