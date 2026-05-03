# Insighta Labs+ Backend API

> **Stage 3 — HNG Backend Engineering Track**
>
> Secure, multi-interface Demographic Intelligence Platform

**Live API:** `https://insighta-backend-production-b142.up.railway.app`

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Insighta Labs+ Platform                    │
│                                                              │
│  ┌─────────┐     ┌──────────────────┐     ┌──────────────┐  │
│  │   CLI   │────▶│  Fastify Backend │◀────│  Web Portal  │  │
│  │  (Node) │     │   (Railway)      │     │  (Railway)   │  │
│  └─────────┘     └────────┬─────────┘     └──────────────┘  │
│                           │                                   │
│                   ┌───────▼──────┐                           │
│                   │  PostgreSQL  │                           │
│                   │  (Railway)   │                           │
│                   └──────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

**Stack:** Fastify · PostgreSQL (Knex) · JWT · GitHub OAuth · Railway

---

## Authentication Flow

### Web Flow (HTTP-only Cookies)
```
User → GET /auth/github
     → GitHub OAuth consent
     → GET /auth/github/callback
     → Backend upserts user, issues token pair
     → Sets HTTP-only cookies (access_token + refresh_token)
     → Redirect → /dashboard.html (no tokens in URL)

Every API call → cookies attached automatically by browser
              → Backend reads cookie, validates JWT
```

### CLI Flow (PKCE + Local Callback)
```
$ insighta login
→ Generates: state, code_verifier, code_challenge (SHA-256)
→ Starts HTTP server on localhost:9876
→ Opens: /auth/github?cli=1&port=9876
→ GitHub OAuth → backend callback
→ Backend redirects to: localhost:9876/callback?access_token=...
→ CLI stores tokens in ~/.insighta/credentials.json
```

---

## Token Handling

| Token | Storage | Expiry | Transport |
|-------|---------|--------|-----------|
| Access Token | HTTP-only cookie (web) / credentials.json (CLI) | 3 minutes | Cookie / Bearer header |
| Refresh Token | HTTP-only cookie (web) / credentials.json (CLI) | 5 minutes | Cookie / Request body |

**Rotation:** Each `POST /auth/refresh` invalidates the old refresh token immediately and issues a new pair. Replay attacks are blocked — a used token returns `401`.

---

## API Endpoints

### Authentication (`/auth/*`) — 10 req/min

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/github` | Redirect to GitHub OAuth |
| GET | `/auth/github/callback` | Handle callback, issue tokens |
| POST | `/auth/refresh` | Rotate token pair |
| POST | `/auth/logout` | Invalidate tokens |
| GET | `/auth/me` | Current user info |

### Profiles (`/api/*`) — 60 req/min · requires `X-API-Version: 1`

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/profiles` | Any | List with filters, sort, pagination |
| GET | `/api/profiles/:id` | Any | Single profile |
| GET | `/api/profiles/search?q=` | Any | Natural language search |
| GET | `/api/profiles/export?format=csv` | Any | CSV export |
| POST | `/api/profiles` | Admin only | Create profile via external APIs |
| DELETE | `/api/profiles/:id` | Admin only | Delete profile |

### Query Parameters (GET /api/profiles)
- `gender` — `male` or `female`
- `age_group` — `child`, `teenager`, `adult`, `senior`
- `country_id` — 2-letter ISO code (e.g. `NG`)
- `min_age`, `max_age` — integer range
- `sort_by` — `age`, `created_at`, `gender_probability`
- `order` — `asc` or `desc`
- `page`, `limit` (max 50)

---

## Role Enforcement

| Role | Permissions |
|------|------------|
| `admin` | Full access — create, delete, read, search, export |
| `analyst` | Read-only — list, get, search, export |

All `/api/*` routes require:
1. Valid `Authorization: Bearer <token>` header (CLI) **or** `access_token` cookie (web)
2. `X-API-Version: 1` header
3. Active account (`is_active = true`)

Enforcement is centralized via Fastify hooks (`preHandler`) — no scattered if-checks.

---

## Natural Language Parsing

The NLP module (`lib/nlp.js`) parses free-text queries into structured filters:

| Input phrase | Extracted filter |
|---|---|
| "young males" | `gender: male, age_group: teenager/adult` |
| "from nigeria" | `country_id: NG` |
| "above 30" / "older than 30" | `min_age: 30` |
| "between 25 and 40" | `min_age: 25, max_age: 40` |
| "seniors" | `age_group: senior` |

---

## Rate Limiting

- `/auth/*` — 10 requests/minute
- `/api/*` — 60 requests/minute per user

Returns `429 Too Many Requests` with `{ status: "error", message: "Too many requests" }`.

---

## Local Setup

```bash
git clone https://github.com/cybarry/insighta-backend.git
cd insighta-backend
npm install
cp .env.example .env
# Fill in .env values
npm run migrate
npm run seed
npm run dev
```

### Environment Variables

```env
PORT=3000
DATABASE_URL=postgresql://user:pass@host:5432/dbname
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
GITHUB_CALLBACK_URL=https://your-backend.up.railway.app/auth/github/callback
JWT_ACCESS_SECRET=your_long_random_secret
JWT_REFRESH_SECRET=another_long_random_secret
FRONTEND_URL=https://your-web.up.railway.app
ALLOWED_ORIGINS=https://your-web.up.railway.app
NODE_ENV=production
```

---

## Database Schema

```sql
profiles       — id, name, gender, gender_probability, age, age_group,
                 country_id, country_name, country_probability, created_at

users          — id (UUIDv7), github_id, username, email, avatar_url,
                 role, is_active, last_login_at, created_at

refresh_tokens — id, user_id (FK→users), token, used, expires_at, created_at
```

---

## CI/CD

GitHub Actions runs on every PR to `main`:
- Syntax check all JS files
- Verify server starts and `/health` returns `200`