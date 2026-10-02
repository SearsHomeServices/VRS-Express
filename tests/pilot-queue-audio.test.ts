// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../client/src/lib/auth", () => ({ getToken: () => null }));
import {
  playPilotQueueChime, playNotificationDing, setCachedVolume, getSelectedTone,
} from "../client/src/lib/websocket";

const oscillators: any[] = [];
const gains: any[] = [];
const context = {
  state: "running", currentTime: 10, destination: {},
  resume: vi.fn(),
  createGain: vi.fn(() => {
    const node = { connect: vi.fn(), gain: {
      setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(),
    } };
    gains.push(node);
    return node;
  }),
  createOscillator: vi.fn(() => {
    const node = {
      type: "", frequency: { value: 0, setValueAtTime: vi.fn() },
      connect: vi.fn(), start: vi.fn(), stop: vi.fn(),
    };
    oscillators.push(node);
    return node;
  }),
};

beforeEach(() => {
  oscillators.length = 0;
  gains.length = 0;
  context.state = "running";
  context.resume.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  setCachedVolume(0.5);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("real Pilot chime implementation with a simulated audio device", () => {
  it("schedules three distinct notes with bounded volume and stop times", () => {
    playPilotQueueChime();
    expect(oscillators.map(node => node.frequency.value)).toEqual([1047, 784, 1319]);
    oscillators.forEach((node, index) => {
      expect(node.start).toHaveBeenCalledWith(10 + index * 0.22);
      expect(node.stop).toHaveBeenCalledWith(10 + index * 0.22 + 0.2);
      expect(gains[index].gain.setValueAtTime).toHaveBeenCalledWith(0.15, 10 + index * 0.22);
    });
  });

  it("creates no sound nodes when muted", () => {
    setCachedVolume(0);
    playPilotQueueChime();
    expect(oscillators).toHaveLength(0);
  });

  it("does not change the traditional selected tone or its playback", () => {
    const selected = getSelectedTone();
    playPilotQueueChime();
    expect(getSelectedTone()).toBe(selected);
    oscillators.length = 0;
    playNotificationDing();
    expect(oscillators).toHaveLength(2);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(880, 10);
  });

  it("waits for browser audio permission before playing", async () => {
    context.state = "suspended";
    playPilotQueueChime();
    expect(oscillators).toHaveLength(0);
    await Promise.resolve();
    expect(oscillators).toHaveLength(3);
  });

  it("honors mute selected while browser audio is resuming", async () => {
    context.state = "suspended";
    playPilotQueueChime();
    setCachedVolume(0);
    await Promise.resolve();
    expect(oscillators).toHaveLength(0);
  });

  it("contains browser resume rejection rather than rejecting into the dashboard", async () => {
    context.state = "suspended";
    context.resume.mockRejectedValueOnce(new Error("autoplay denied"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => playPilotQueueChime()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    expect(oscillators).toHaveLength(0);
  });
});