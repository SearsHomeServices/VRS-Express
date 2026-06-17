# Notification Sound System

- 5 tone options: Chime, Bell, Pulse, Cascade, Alert — each user can choose their own.
- Volume slider 0–100% per user.
- Settings stored per-user on the `users` table (`notificationTone`, `notificationVolume` columns) via `/api/settings/notification-tone` GET/PUT (authenticated, any role).
- Shared `NotificationSettings` dialog component (`client/src/components/notification-settings.tsx`) with gear icon, accessible from both admin and agent sidebar footers above Help Center.
- All users load their settings on dashboard init via `loadNotificationSettings()` in `client/src/lib/websocket.ts` (sends Bearer token).
