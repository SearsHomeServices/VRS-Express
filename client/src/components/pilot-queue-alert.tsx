import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { canUseVrsAiPilot } from "@shared/vrs-ai-pilot";
import { JITTERED_POLL_INTERVAL_MS, queryClient } from "@/lib/queryClient";
import { loadNotificationSettings, playPilotNewTicketAlert, useWebSocket } from "@/lib/websocket";

type QueueData = { submissions: { id: number }[] };
export const PILOT_WAITING_URL = "/api/submissions?vrsAiOnly=true&ticketStatus=queued";
export const PILOT_WORKING_URL = "/api/submissions?vrsAiOnly=true&ticketStatus=pending";

/** Mounted in navigation, not in the queue page. No changes to ticket workflows. */
export function PilotQueueAlert() {
  const { user } = useAuth();
  const enabled = !!user && canUseVrsAiPilot(user.role);
  const { subscribe } = useWebSocket();
  const [soundReady, setSoundReady] = useState(false);
  const seen = useRef<Set<number> | null>(null);
  const waiting = useQuery<QueueData>({
    queryKey: [PILOT_WAITING_URL], enabled,
    refetchInterval: JITTERED_POLL_INTERVAL_MS, staleTime: 0,
  });
  const working = useQuery<QueueData>({
    queryKey: [PILOT_WORKING_URL], enabled,
    refetchInterval: JITTERED_POLL_INTERVAL_MS, staleTime: 0,
  });

  useEffect(() => {
    seen.current = null;
    setSoundReady(false);
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        await loadNotificationSettings({ requireSuccess: true });
        if (live) setSoundReady(true);
      } catch {
        if (live) timer = setTimeout(load, 30000);
      }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [user?.id, enabled]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      // Intake may broadcast before its bridge link commits. Also let the
      // existing two-second staff cache expire; coalesce event bursts.
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({ queryKey: [PILOT_WAITING_URL] });
        void queryClient.invalidateQueries({ queryKey: [PILOT_WORKING_URL] });
      }, 2500);
    };
    const unsubscribe = [
      "new_ticket", "ticket_claimed", "ticket_queued", "pending_tickets",
      "resubmission_received", "ticket_assigned", "ticket_updated", "connected",
    ].map(event => subscribe(event, refresh));
    return () => { unsubscribe.forEach(fn => fn()); clearTimeout(timer); };
  }, [enabled, subscribe]);

  useEffect(() => {
    if (!enabled || !waiting.isFetchedAfterMount || waiting.isError || !waiting.data) return;
    const ids = waiting.data.submissions.map(row => row.id);
    if (seen.current === null) {
      seen.current = new Set(ids); // Initial load is a baseline, not new arrivals.
      return;
    }
    const arrived = ids.some(id => !seen.current!.has(id));
    ids.forEach(id => seen.current!.add(id));
    if (arrived && soundReady) playPilotNewTicketAlert();
  }, [enabled, waiting.data, waiting.isFetchedAfterMount, waiting.isError, soundReady]);

  if (!enabled) return null;
  const count = (waiting.data?.submissions.length ?? 0) + (working.data?.submissions.length ?? 0);
  const failed = waiting.isError || working.isError;
  const loading = !waiting.data || !working.data;
  return (
    <span
      data-testid="pilot-pending-count"
      role="status"
      aria-atomic="true"
      aria-label={failed ? "Pilot pending count unavailable; retrying" : loading ? "Loading Pilot pending count" : `${count} pending Pilot tickets`}
      title={failed ? "Unable to refresh count; retrying automatically" : `${waiting.data?.submissions.length ?? 0} waiting · ${working.data?.submissions.length ?? 0} in progress`}
      className={`ml-auto rounded-full border px-2 py-0.5 text-xs font-semibold ${!failed && !loading && count > 0 ? "pilot-pending-alert" : "text-muted-foreground"}`}
    >
      {failed ? "!" : loading ? "…" : `${count} pending`}
    </span>
  );
}
