# VRS Digital Authorization Platform

A modern mobile PWA and desktop dashboard system for **Sears Home Services** that digitizes field technician authorization requests. Replaces traditional call-in workflows with real-time submission, review, and approval processes.

---

## 🎯 Overview

The **VRS Digital Authorization Platform** enables:

- **Technicians** → Submit authorization requests with photos and part splits from mobile PWA
- **VRS Agents** → Review, approve/reject, and manage queue in real-time dashboard
- **Admins** → Manage users, analytics, exports, and system configuration
- **Real-time Updates** → WebSocket-powered notifications and live queue synchronization

---

## 🏗️ Architecture

### Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 20, TypeScript |
| **Backend** | Express 4, WebSocket (`ws`) for real-time |
| **Frontend** | React 18, Vite, TailwindCSS, shadcn/ui |
| **Database** | PostgreSQL (Neon), Drizzle ORM |
| **Authentication** | JWT (jsonwebtoken) + bcryptjs, RBAC |
| **File Storage** | Google Cloud Storage (Replit Object Storage) |
| **SMS** | Twilio |
| **AI** | OpenAI (description enhancement) |
| **Integrations** | Snowflake, LDAP, SHSAI, PDC |
| **Export** | ExcelJS (XLSX), CSV |
| **Routing** | Wouter (frontend) |
| **Data Fetching** | TanStack Query v5 |

### Directory Structure

```
├── client/src/
│   ├── pages/
│   │   ├── tech-*.tsx            # Technician flows (login, submit, history, resubmit, feedback)
│   │   ├── agent-*.tsx           # Agent flows (login, dashboard with queue/tickets/NLA)
│   │   ├── admin-*.tsx           # Admin flows (login, user management, analytics)
│   │   ├── submission-detail.tsx # Shared detail view
│   │   ├── help-center.tsx       # Searchable FAQ
│   │   └── landing.tsx           # Public landing page
│   ├── components/
│   │   ├── bottom-nav.tsx        # Mobile bottom navigation
│   │   ├── notification-settings.tsx
│   │   ├── onboarding-wizard.tsx
│   │   ├── whats-new-modal.tsx
│   │   ├── photo-lightbox.tsx
│   │   ├── ObjectUploader.tsx    # GCS file upload
│   │   └── ui/                   # shadcn/ui components
│   ├── lib/
│   │   ├── auth.tsx              # JWT token & useAuth hook
│   │   ├── websocket.ts          # WebSocket client
│   │   ├── queryClient.ts        # TanStack Query setup
│   │   └── utils.ts              # Utilities
│   └── App.tsx                   # Router (wouter)
│
├── server/
│   ├── index.ts                  # Express + Vite + WebSocket bootstrap
│   ├── routes.ts                 # All API endpoints (~3200 lines)
│   ├── storage.ts                # IStorage interface + Drizzle implementation
│   ├── websocket.ts              # WebSocket server, broadcast functions
│   ├── seed.ts                   # Database seeding & migrations
│   ├── sms.ts                    # Twilio SMS service
│   ├── middleware/auth.ts        # JWT & RBAC middleware
│   ├── services/
│   │   ├── openai.ts             # AI description enhancement
│   │   ├── snowflake.ts          # Tech sync, ProcID lookup
│   │   └── shsai.ts              # Service order history
│   └── replit_integrations/      # GCS integration
│
├── shared/
│   └── schema.ts                 # Drizzle database schema
│
├── tests/
│   ├── vrs-sasha-*.test.ts       # VRS-Sasha API tests
│   ├── vrs-ai-bridge-*.test.ts   # AI Bridge integration tests
│   └── tech-pdc-export-parity.test.ts  # Export parity tests
│
└── package.json                   # Dependencies & scripts
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 20+ and npm/yarn
- **PostgreSQL** database (Neon recommended)
- **Environment Variables** (see `.env.example`)

### Environment Setup

Create a `.env` file with:

```env
# Database
DATABASE_URL=postgresql://[user]:[password]@[host]/[db]

# JWT
JWT_SECRET=your_jwt_secret_key

# Google Cloud Storage
GOOGLE_APPLICATION_CREDENTIALS=path/to/credentials.json

# Twilio (SMS)
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890

# OpenAI
OPENAI_API_KEY=your_openai_key

# Snowflake
SNOWFLAKE_ACCOUNT=your_account
SNOWFLAKE_USER=your_user
SNOWFLAKE_PASSWORD=your_password

# LDAP
LDAP_SERVER_URL=ldap://your_server

# SHSAI
SHSAI_API_URL=https://api.shsai.example.com
SHSAI_API_KEY=your_api_key

# App
NODE_ENV=development
PORT=3000
VITE_API_URL=http://localhost:3000
```

### Installation

```bash
# Install dependencies
npm install

# Run database migrations
npm run db:push

# Seed test data (development only)
npm run seed

# Start development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

---

## 📱 Features

### Technician Portal

- **🔐 LDAP Login** — Single sign-on with no password required
- **📸 Photo Submission** — Capture authorization photos with automatic compression
- **🔀 NLA Part Split** — Divide work into NLA (Not Labor Approved) and labor components
- **📋 History** — View submission status, approvals, rejections
- **🔄 Resubmit** — Correct and resubmit rejected requests
- **💬 Feedback Form** — Report issues, suggest improvements
- **📲 PWA Ready** — Install to home screen, offline-capable

### Agent Dashboard

- **📊 Live Queue** — Real-time submission queue with WebSocket updates
- **🎫 My Tickets** — Agent-assigned submissions
- **⚠️ NLA Tab** — Filter for NLA-related work
- **✅ Approve/Reject** — Process with notes
- **🔔 Notifications** — Sound alerts for new submissions
- **📱 Responsive** — Desktop & tablet optimized

### Admin Console

- **👥 User Management** — Create, update, disable technicians, agents, admins
- **📈 Analytics** — Submission trends, approval rates, performance metrics
- **📊 Export Data** — XLSX, CSV exports for reporting
- **⚙️ System Settings** — Configure notifications, roles, integrations
- **🔍 Audit Log** — Track user actions for compliance

---

## 🔐 Authentication & Authorization

### RBAC Roles

| Role | Capabilities |
|------|--------------|
| **technician** | Submit requests, view own submissions, resubmit, feedback |
| **vrs_agent** | Review queue, approve/reject, assign tickets, manage workload |
| **admin** | User management, analytics, exports, system settings |
| **super_admin** | Full access, audit logs, database management |

### Auth Flow

1. **Technician**: LDAP login (no password) → JWT token
2. **Agent/Admin**: Email + password → LDAP verification → JWT token
3. **Token**: Stored in localStorage, sent in `Authorization: Bearer <token>` header
4. **Middleware**: All routes protected with `authenticateToken` + `requireRole` middleware

---

## 🌐 API Endpoints

### Authentication

- `POST /api/auth/tech-login` — Technician LDAP login
- `POST /api/auth/login` — Agent/Admin login
- `POST /api/auth/logout` — Logout & invalidate session
- `GET /api/auth/me` — Get current user profile

### Submissions

- `GET /api/submissions` — List submissions (filtered by role)
- `POST /api/submissions` — Create new submission
- `GET /api/submissions/:id` — Get submission detail
- `PATCH /api/submissions/:id` — Update submission (approve/reject/notes)
- `POST /api/submissions/:id/resubmit` — Resubmit rejected submission
- `GET /api/submissions/:id/history` — Get submission audit trail

### Real-time

- `WS /ws` — WebSocket connection for live updates
  - `submission:new` — New submission created
  - `submission:updated` — Submission status changed
  - `queue:refresh` — Queue refreshed

### Users (Admin)

- `GET /api/admin/users` — List all users
- `POST /api/admin/users` — Create user
- `PATCH /api/admin/users/:id` — Update user
- `DELETE /api/admin/users/:id` — Disable user

### Analytics

- `GET /api/admin/analytics/dashboard` — Overview metrics
- `GET /api/admin/analytics/submissions` — Submission trends
- `GET /api/admin/analytics/performance` — Agent performance

### Exports

- `POST /api/admin/export/submissions` — Export submissions as XLSX/CSV
- `POST /api/admin/export/users` — Export users
- `POST /api/admin/export/analytics` — Export analytics report

---

## 📡 Real-time Features

### WebSocket Events

**Client → Server:**
```typescript
{
  type: "subscription:queue",
  payload: { vrs_agent_id?: string }
}
```

**Server → Client:**
```typescript
{
  type: "submission:new",
  payload: { submission_id, tech_id, status, created_at }
}

{
  type: "submission:updated",
  payload: { submission_id, status, approved_by, notes }
}

{
  type: "notification",
  payload: { message, type: "success|warning|error", duration }
}
```

### Notification Preferences

- 🔔 Sound alerts (enabled/disabled)
- 🔊 Volume control
- ⏰ Quiet hours
- 📧 Email digest (daily/weekly/off)

---

## 🧪 Testing

Run tests with:

```bash
# All tests
npm test

# Specific test suite
npm run test:vrs-sasha
npm run test:vrs-ai-bridge
npm run test:vrs-bridge-docs
npm run test:tech-pdc-parity
```

### Test Coverage

- **VRS-Sasha Integration** — API v5, Queue, Contract tests
- **AI Bridge** — Description enhancement, contract mapping
- **Export Parity** — PDC export format alignment

---

## 🔌 External Integrations

### Snowflake

- **Tech Sync** — Fetch technician list from Snowflake daily
- **ProcID Lookup** — Resolve procedure codes
- **Service History** — Query service order details

### SHSAI

- **Service Order History** — Retrieve completed jobs for context

### LDAP

- **Authentication** — Verify technician/agent credentials
- **Sync** — Periodic user directory sync

### Twilio SMS

- **Notifications** — SMS alerts to technicians
- **Callbacks** — Status updates via SMS

### OpenAI

- **Description Enhancement** — AI-generated descriptions from photos
- **Smart Suggestions** — Part recommendations based on images

---

## 📊 Database Schema

### Core Tables

- **users** — Technicians, agents, admins with RBAC roles
- **submissions** — Authorization requests with status tracking
- **submission_items** — Individual parts/labor splits per submission
- **submission_attachments** — Photos and documents
- **approval_history** — Audit trail of approvals/rejections
- **notifications** — System notifications & preferences
- **audit_logs** — User action tracking for compliance

See `shared/schema.ts` for full schema definition.

---

## 🛠️ Development Workflow

### Local Development

```bash
# 1. Install dependencies
npm install

# 2. Set up .env with database URL
cp .env.example .env

# 3. Push schema to database
npm run db:push

# 4. Seed with test data
npm run seed

# 5. Start dev server (watches both client & server)
npm run dev

# 6. Open http://localhost:5173 in browser
```

### Type Checking

```bash
npm run check  # Run TypeScript compiler
```

### Production Build

```bash
npm run build  # Builds to dist/
npm start      # Runs production server
```

---

## 📦 Deployment

### Replit

This project is optimized for **Replit** deployment:

1. Fork repository to your Replit account
2. Set environment variables in Replit Secrets
3. Run `npm install` → `npm run build` → `npm start`
4. Deploy to Replit URL or connect custom domain

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install && npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

### Environment Variables (Production)

Ensure all `.env` variables are set in your hosting platform's secret management.

---

## 📝 Project Conventions

### Code Organization

- **Pages** — Full-screen React components (pages/)
- **Components** — Reusable UI elements (components/)
- **Services** — External integrations (server/services/)
- **Middleware** — Express middleware (server/middleware/)
- **Utilities** — Helper functions (lib/utils.ts, shared/)

### Naming

- Files: `kebab-case` (e.g., `tech-login.tsx`)
- Variables/Functions: `camelCase`
- Types/Interfaces: `PascalCase`
- Database Tables: `snake_case`
- API Routes: `/api/resource/action` pattern

### Git Workflow

1. Create branch: `git checkout -b feature/your-feature`
2. Make changes, commit: `git commit -m "feat: description"`
3. Push: `git push origin feature/your-feature`
4. Open Pull Request
5. **Before marking done: Update**
   - `CHANGELOG.md` (under [Unreleased])
   - `.claude/memory/context.md` (new context)
   - `.claude/memory/todos.md` (check off done items)
   - `.claude/memory/decisions.md` (architectural choices)

---

## 🐛 Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| `DATABASE_URL not set` | Check `.env` file and ensure `DATABASE_URL` is present |
| `ECONNREFUSED localhost:5432` | Ensure PostgreSQL is running or update DATABASE_URL |
| `Module not found` | Run `npm install` to ensure all dependencies are installed |
| `WebSocket connection failed` | Check `VITE_API_URL` matches backend URL in browser console |
| `Photos not uploading` | Verify `GOOGLE_APPLICATION_CREDENTIALS` path and GCS permissions |
| `SMS not sending` | Check Twilio credentials and verify phone number format |

### Debug Mode

```bash
# Enable verbose logging
DEBUG=* npm run dev

# Check database connection
npm run db:push -- --verbose
```

---

## 📚 Documentation

- **Architecture** → See `ARCHITECTURE.md`
- **API Reference** → See `docs/api.md`
- **Database** → See `docs/database.md`
- **Deployment** → See `docs/deployment.md`
- **Changelog** → See `CHANGELOG.md`

---

## 📄 License

MIT License — See LICENSE file for details.

---

## 🤝 Contributing

1. Follow the conventions above
2. Write tests for new features
3. Update documentation
4. **Update memory files before marking done** (CHANGELOG, context, todos, decisions)
5. Request review on pull requests

---

## 📞 Support

- **Issues** → GitHub Issues (this repo)
- **Discussions** → GitHub Discussions
- **Email** → [team email]

---

**Built with ❤️ for Sears Home Services**
