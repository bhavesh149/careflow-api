# Careflow backend

Appointment booking API: hexagonal Node 22 + Fastify + Postgres. Three API tasks share one
database that enforces “no double booking”; workers publish notifications off a transactional
outbox.

Companion UI: [careflow-app](https://github.com/bhavesh149/careflow-app) (React SPA).

| | |
| --- | --- |
| **Live app** | [S3 website](http://careflow-web-853184314326.s3-website.ap-south-1.amazonaws.com) |
| **API (AWS ALB)** | http://carefl-alb16-n1msowftsytk-1345249308.ap-south-1.elb.amazonaws.com |
| **Swagger** | […/docs](http://carefl-alb16-n1msowftsytk-1345249308.ap-south-1.elb.amazonaws.com/docs) |
| API locally (nginx, stands in for the ALB) | http://localhost:8080 |
| Swagger locally | http://localhost:8080/docs |
| Direct tasks | http://localhost:3001 · 3002 · 3003 |
| OpenAPI file | [`docs/api/openapi.json`](docs/api/openapi.json) |
| Postman | [`docs/postman/`](docs/postman/) |
| AWS infrastructure | [`docs/06-aws-infrastructure.md`](docs/06-aws-infrastructure.md) |
| AI usage | [`AI_USAGE.md`](AI_USAGE.md) |

---

## Status

Auth, schedules, availability, holds, one-time and recurring booking, cancel/status, session
revoke on logout, workers, tests, local Docker stack, AWS deploy, and GitHub Actions
(PR gate + ECS deploy) are in this repo. The React app lives in [careflow-app](https://github.com/bhavesh149/careflow-app).

| Item | Notes |
| --- | --- |
| **HTTPS / custom domain** | No ACM cert; ALB is HTTP so the S3 website can call it without mixed content. |
| **Real notification sender** | Outbox → SQS → consumer is wired. The consumer logs; SES / Twilio are not connected. |
| **Teardown** | `make aws-destroy` when you no longer need the stack, or it keeps billing. |

---

## Setup (clone this repo)

This folder **is** the GitHub repository root. `make up` is run **here**, not in a parent
directory.

**Need:** Docker Desktop, Node 22+, npm 10+.

```bash
git clone git@github.com:YOUR_ORG/careflow-backend.git
cd careflow-backend

cp .env.example .env          # gitignored; already done if you copied a working tree
make up                       # or: docker compose up -d --build
```

`make up` builds the image, starts Postgres 17, Redis 7, LocalStack SQS, runs migrations + seed,
then three API replicas, nginx, and three workers.

Wait until nginx is healthy, then:

```bash
curl -fsS http://localhost:8080/health
curl -fsS http://localhost:8080/ready
make smoke                    # booking journey through nginx (needs jq)
```

Stop with `make down`. Wipe the database volume with `make reset`.

If you still have the old monorepo checkout (parent folder with `backend/` inside), `make up`
from that parent still forwards here.

### Seeded accounts

Password for all of them: `Careflow!2026`

| Email | Role |
| --- | --- |
| `patient@careflow.test` | PATIENT |
| `patient2@careflow.test` | PATIENT |
| `patient3@careflow.test` | PATIENT |
| `dr.mehta@careflow.test` | THERAPIST |
| `dr.rao@careflow.test` | THERAPIST |
| `dr.iyer@careflow.test` | THERAPIST |

### Environment files

| File | Git | Purpose |
| --- | --- | --- |
| [`.env.example`](.env.example) | committed | Every variable the process reads, with laptop defaults (`localhost`) |
| [`.env`](.env) | **ignored** | What you actually run. Copy of the example; edit this, not the example |

The process loads `.env` at boot (`process.loadEnvFile`). Variables already in the environment
win, so Docker Compose can point `DATABASE_URL` at host `postgres` without you maintaining two
files.

In AWS the same names are injected from Secrets Manager. There is no `.env` on the tasks.
Deploy: [`infra/README.md`](infra/README.md). Why each service exists: [`docs/06-aws-infrastructure.md`](docs/06-aws-infrastructure.md).

Hostnames in `.env` are `localhost` so `npm run dev` against published ports works. Compose
overrides Postgres / Redis / SQS URLs to Compose DNS names.

---

## Run

### Full local stack (what you should use)

From this directory:

```bash
make up          # start
make logs        # tail
make ps          # status
make migrate     # apply SQL
make seed        # re-seed demo users
make smoke       # booking journey through nginx
make down        # stop
```

API entry is **http://localhost:8080** (nginx in front of three replicas), not a single Node
process. That is deliberate: a hold created on task 1 and confirmed on task 2 is the production
path.

### API only, on the host

With the Compose data plane already up (Postgres, Redis, LocalStack):

```bash
npm ci
npm run db:migrate
npm run db:seed
npm run dev                 # API on :3000, loads .env
```

Workers, extra terminals:

```bash
npm run dev:outbox
npm run dev:notifications
npm run dev:sweeper
```

### Tests

```bash
npm ci
npm run test:unit           # no Docker; domain logic
npm run test:integration    # Testcontainers Postgres (or TEST_DATABASE_URL in CI)
npm run test:concurrency    # exactly one winner under parallel holds/confirms
npm run test:e2e            # HTTP journeys through the real app
npm run test:all
npm run test:api            # newman against a running stack on :8080
```

Docker must be running for integration / concurrency / e2e.

### Quality

```bash
npm run typecheck
npm run lint
npm run openapi:export      # writes docs/api/openapi.json; CI fails on a drift
```

---

## Use the API

Swagger: http://localhost:8080/docs — Authorize with the access token from login.

```bash
curl -sX POST http://localhost:8080/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"patient@careflow.test","password":"Careflow!2026"}'
```

Access token is in the JSON body (15 min). Refresh token is in that same JSON (for cross-origin SPAs) and as an `httpOnly` cookie on `/v1/auth` for same-origin clients.
Send `Authorization: Bearer <token>` on everything else. Cross-origin clients send `{ "refreshToken" }` on `POST /v1/auth/refresh`.

State-changing booking routes **require** `Idempotency-Key` (UUID). Reuse the same key to retry;
a different body on the same key returns `422 IDEMPOTENCY_KEY_REUSED`.

Postman: import `docs/postman/Careflow.postman_collection.json` and
`docs/postman/Careflow.local.postman_environment.json`, run top to bottom. Tokens and ids are
captured automatically. Details: [`docs/03-api-guide.md`](docs/03-api-guide.md).

---

## Implementation guide (what and why)

### Shape

Modular monolith, hexagonal modules under `src/modules/{auth,scheduling,availability,booking}`
with `domain / application / infrastructure / presentation`. ESLint `no-restricted-imports`
blocks domain from importing Fastify, `pg`, or Drizzle. Three ECS-style processes — API,
outbox publisher, notification consumer, hold sweeper — not threads inside the API. Local
Compose matches that topology so “works on my machine” includes the distributed cases.

### Correctness (the actual product)

Application checks are for clear errors. The guarantee is Postgres:

1. **GiST exclusion constraints** on `appointments` and `holds` (`btree_gist` + half-open
   `tstzrange`). Two concurrent inserts cannot both commit. Back-to-back 10:00–11:00 and
   11:00–12:00 are allowed. `CANCELLED` rows drop out of the constraint so the slot is free
   immediately.
2. **Row locks** — `SELECT … FOR UPDATE` on the hold being confirmed, so two confirms of the
   same hold serialize. Recurring confirm takes `pg_advisory_xact_lock` per therapist so
   validate-then-insert cannot interleave into a partial series.
3. **Idempotency in Postgres** — `UNIQUE(actor_id, key, operation)`, two-phase
   `PROCESSING` → `COMPLETED`. All three API tasks replay the same response. Isolation is
   READ COMMITTED, not SERIALIZABLE (retry storms under contention).

Holds expire by `expires_at` in the database, not `setTimeout`. The exclusion predicate cannot
use `now()` (not IMMUTABLE), so create-hold first flips lapsed `ACTIVE` rows to `EXPIRED`, and
a sweeper worker is hygiene, not correctness.

### Auth and HTTP

Argon2id hashes, 15-minute JWT, rotating refresh cookie with family reuse-detection (stolen
token → whole family revoked). Login is rate-limited separately and more tightly. Redis down
fails *open* for rate limits (in-process fallback) so a cache outage cannot stop booking;
`/ready` reports the degradation.

### Async

Transactional outbox: the appointment row and its event commit together. A publisher polls
`FOR UPDATE SKIP LOCKED` onto SQS (LocalStack locally). The consumer deduplicates with
`processed_messages` because delivery is at-least-once.

### Product policy (configurable in `.env`)

| Setting | Default |
| --- | --- |
| Slot length | 60 minutes |
| Hold TTL | 60 seconds, max 3 active per patient |
| Recurrence horizon | `min(26 occurrences, 6 months)` |
| Monthly on the 31st | clamp to last valid day of that month |
| Recurring confirm | all-or-nothing; 409 lists every clash |
| Series cancel | future `SCHEDULED` only; past is immutable |
| Therapist outcome window | from `start_time` until `end_time + 24h` |
| Time | stored UTC; schedules expanded in `APP_TIMEZONE` (Asia/Kolkata) |

### Layout

```
.                          # this directory is the GitHub repo root
  src/modules/…            # hexagonal modules
  src/shared/              # config, db, errors, idempotency, http
  src/workers/             # outbox, notifications, hold sweeper
  migrations/              # reviewed SQL, not drizzle-kit push
  tests/{unit,integration,concurrency,e2e}
  docker/                  # nginx, postgres init, localstack init
  docker-compose.yml
  Makefile                 # make up / down / test / smoke
  docs/                    # API guide, OpenAPI, Postman, AWS runbook
  infra/                   # AWS CDK app; stack construct still to write
  .github/workflows/       # PR gate + ECS deploy
  .env.example             # committed
  .env                     # local, gitignored
```

Migrations are hand-written SQL with checksums and a session advisory lock. A schema differ
must not be allowed to drop `appointments_no_overlap`.

### CI / CD

Workflows live in `.github/workflows/` of **this** repo:

- **PR** — typecheck, lint, unit, `npm audit --omit=dev`, OpenAPI drift, integration against a
  Postgres 17 service, Docker build, Trivy (HIGH/CRITICAL). No AWS credentials required.
- **main (Deploy)** — push to ECR → gated migration `RunTask` (must exit 0) → CDK deploy with
  ECS circuit-breaker rollback → smoke `/health` + `/ready`. Needs GitHub secret
  `AWS_DEPLOY_ROLE_ARN`. Needs the CDK stack to exist and the account to be bootstrapped —
  see [`infra/README.md`](infra/README.md).

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Invalid configuration` on boot | `.env` missing; `cp .env.example .env` |
| Login `429` in smoke/Postman | Expected against a single IP through nginx; Compose raises `RATE_LIMIT_LOGIN_MAX` to 100 |
| nginx `502` after recreating API containers | Stale DNS — Compose aliases all three APIs as `api` and nginx re-resolves; `make down && make up` if an old nginx is still up |
| Integration tests skip/fail | Docker Desktop not running, or `TEST_DATABASE_URL` pointed at a dead Postgres |
| Hold create `409` after TTL | Sweeper not required; create-hold should reclaim. Check `expires_at` vs `status = ACTIVE` |
| `make: docker-compose.yml: No such file` after a GitHub clone | You cloned the parent folder, not this backend as repo root. `cd` into the folder that contains `docker-compose.yml` |

---

## Commands

```text
make up | down | reset | logs | ps
make migrate | seed | psql
make test-unit | test-integration | test-concurrency | test-e2e | test-all
make typecheck | lint | openapi | smoke
```
