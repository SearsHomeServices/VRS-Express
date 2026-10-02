import { useEffect, useRef, useState } from "react";
import { categoryForApplianceType, getBusinessElapsedMs, type BusinessHoursConfig } from "@shared/business-hours";
import type { QueueWaitState } from "@shared/nla-ready-for-order";
import { getNotificationVolume, loadNotificationSettings, playNotificationDing } from "@/lib/websocket";

export type QueueAlertTicket = QueueWaitState & { id: number; applianceType?: string | null };
export const QUEUE_ALERT_THRESHOLD_MS = 5 * 60 * 1000;

export function isQueueWaitOverdue(ticket: QueueAlertTicket, now: number, config: BusinessHoursConfig): boolean {
  if (ticket.ticketStatus !== "queued" || ticket.claimedAt != null || ticket.nlaReadyForOrderAt != null
    || (ticket.requestType === "parts_nla" && ticket.nlaEscalatedBy != null)) return false;
  if (!ticket.createdAt) return false;
  const created = new Date(ticket.createdAt);
  if (!Number.isFinite(created.getTime())) return false;
  return getBusinessElapsedMs(created, new Date(now), config[categoryForApplianceType(ticket.applianceType ?? "")])
    >= QUEUE_ALERT_THRESHOLD_MS;
}

export function useQueueWaitAlerts(tickets: QueueAlertTicket[], config: BusinessHoursConfig) {
  const [now, setNow] = useState(Date.now);
  const [settingsReady, setSettingsReady] = useState(false);
  const alerted = useRef(new Set<number>());

  useEffect(() => {
    let active = true;
    void loadNotificationSettings().then(() => { if (active) setSettingsReady(true); });
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    let newlyOverdue = false;
    for (const ticket of tickets) {
      if (isQueueWaitOverdue(ticket, now, config) && !alerted.current.has(ticket.id)) {
        alerted.current.add(ticket.id);
        newlyOverdue = true;
      }
    }
    // Batch simultaneous crossings into one chime. The existing player honors
    // the current tone and volume (including mute); no repeating alarm.
    if (newlyOverdue && getNotificationVolume() > 0) playNotificationDing();
  }, [tickets, config, now, settingsReady]);

  return now;
}