# AI usage

This file records how AI was used while building Careflow, and which decisions stayed human.
It exists because the assignment asks for it — not because the AI wrote the product unattended.

**Tool:** [Cursor](https://cursor.com) with Grok 4.6, in an agentic coding session against this repository.
**Human:** product intent, stack confirmation, AWS account/IAM, secrets, deploy, review of generated code, and every “no” that overrode a cheaper or less-correct suggestion.

The API in this repo is the result. The React SPA is [careflow-app](https://github.com/bhavesh149/careflow-app) (its own `AI_USAGE.md`).

---

## What AI was used for

- Scaffolding the Node 22 / TypeScript / Fastify / Vitest / Docker / CDK layout from `Technical_Design.md`.
- Hexagonal modules (auth, scheduling, availability, booking), workers, migrations, tests, OpenAPI/Postman, GitHub Actions, and AWS CDK.
- Drafting docs (`README.md`, API guide, infrastructure).
- Iterating on CI, Trivy findings, HTTP-ALB cookie/HSTS behaviour, and making this folder a cloneable GitHub root.
- Session revoke on logout so a still-unexpired access JWT cannot call the API.

AI did not run AWS as the account owner. Deploy, secrets, and IAM were executed with the human’s `careflow` profile after review.

---

## Exact prompts (representative)

These are the prompts as typed. Typos left as-is.

### 1. Kick-off — backend first, production-shaped

> You are a senior software engineer. You have to perofrm the given task in such a manner that, it will be production ready and robust. Analyze the code properly, before implementation, check what is implemented and what needs to be implemented. Create a task list for complex task, and don't create such large summary doc.
>
> Let's analyze the Technical_Design.md Technical document first.
> Let's plan the backend first with end to end implementation backend development to deployment.
> As our priority is to showcase our seniority in this project, so accordingly create plan and Implement.
> This should follow the security measures, idepotency, db concurrency, etc.
> Also, give the architecture design code as well so that i can create it from any platform and add that image here. Create one doc folder and insert the implementation guide what used and why…

**What followed:** a plan covering hexagonal modules, Postgres as source of truth, GiST exclusion, idempotency, outbox, three API replicas, workers, tests, CDK, and CI. Implementation then ran against that plan rather than against a one-shot “write the app” prompt.

### 2. Split the frontend out; make the backend repo self-contained

> bro, i will create separate repo for fronend and backend folder accordingly create the github cicd and shhift this docs to bacjkend folder.

**What followed:** Compose, Makefile, Docker, docs, and GitHub Actions moved under this directory so `git clone` → `cp .env.example .env` → `make up` works. The SPA is a sibling repo: [careflow-app](https://github.com/bhavesh149/careflow-app).

### 3. AWS deploy — ALB hostname, three ECS tasks, no custom domain

> cool, now we are with the aws account with iam user setup here in this device. Now lets setup the cdk. Also I dont have doamin so i will be using alb url directly. And I have to run this server for 3-4 days only, so just spin 3 ecs container for showcase.

**What followed:** CDK for ECS Fargate (**3 API tasks** + workers, matching the assignment’s distributed topology), ALB on HTTP, RDS, Redis, SQS, Secrets Manager, region `ap-south-1`. No ACM or Route 53 because there is no domain. No NAT Gateway: Fargate uses a public IP to reach AWS APIs; RDS and Redis stay on isolated subnets. The three-task count is the product requirement, not a temporary size.

---

## Important design decisions

| Decision | Why |
| --- | --- |
| Modular monolith, hexagonal modules | Booking is one transactional domain. Microservices would split the invariant across networks. |
| PostgreSQL owns holds, appointments, and idempotency | Correctness must survive three API tasks and a Redis outage. |
| GiST `EXCLUDE` on appointment/hold ranges | The database, not the Node process, is the last word on double-booking. |
| Derive slots from schedules | Assignment requirement; avoids storing a huge future slot table. |
| 60s hold with `expiresAt` + `serverTime` | Client clocks lie; the server clock is authoritative. |
| Recurring series is all-or-nothing | A partial series is worse than a 409 that lists every clash. |
| Transactional outbox → SQS | Notifications cannot be lost if the process dies after commit. |
| Redis for cache and rate limits only | Fail-open on Redis so a cache outage cannot stop booking. |
| Refresh token in httpOnly cookie; access token in memory | XSS should not yield a long-lived credential; CSRF should not ride on the access token. |
| Logout revokes the session, not only the refresh cookie | A stolen access JWT must fail as soon as the user signs out. |
| HTTP ALB, no custom domain | Human constraint. HTTPS is the next step once a certificate exists. |
| Separate frontend repo | Human constraint. This API is the contract the SPA consumes. |

---

## What AI recommended vs what was implemented

### Booking lock

- **Recommended (common default):** Redis distributed lock (Redlock or `SET NX`) around hold/confirm.
- **Implemented:** Postgres transaction + `btree_gist` exclusion + per-therapist advisory lock on recurring confirm. Redis is not in the booking ownership path.
- **Trade-off:** every booking hits the database. That is the correct trade-off: the rows already live there.

### AWS network

- **Recommended (textbook VPC):** private subnets, NAT Gateway, VPC endpoints for ECR/Logs/Secrets.
- **Implemented:** Fargate in public subnets with a public IP; RDS/Redis isolated. No NAT.
- **Trade-off:** tasks have a public IP. Cheaper and simpler without a domain or NAT budget. A locked-down environment should move tasks private and add NAT or endpoints.

### API compute

- **Recommended (sometimes):** Lambda + API Gateway for “serverless”.
- **Implemented:** ECS Fargate, three long-running API tasks behind an ALB, matching “any instance can handle any request” and keeping a Postgres pool honest.
- **Trade-off:** always-on cost vs Lambda cold starts and RDS proxy. For a booking API with a pool, Fargate is the less surprising runtime.

### Trivy `CVE-2026-59874` (`tar`)

- **Recommended:** bump `tar` in application `package.json`, or `.trivyignore`.
- **Implemented:** the CVE was npm’s bundled `tar` in the image, not an app dependency. The runtime image removes `npm`/`corepack`. No ignore file.
- **Trade-off:** slightly more Dockerfile care; the scanner then reports the image we actually run.

### Swagger on the HTTP ALB

- **Recommended (secure-by-default Helmet):** HSTS + CSP `upgrade-insecure-requests`.
- **Implemented:** those are off unless `COOKIE_SECURE=true`. Browsers were upgrading `http://…elb.amazonaws.com/docs` to HTTPS and failing.
- **Trade-off:** HTTP demo is reachable. Turn HSTS back on the day TLS exists.

### Frontend location

- **Recommended (from the design):** React SPA in the same git repo, S3 + CloudFront.
- **Implemented:** SPA in [careflow-app](https://github.com/bhavesh149/careflow-app), static host on S3 (HTTP, same as the ALB, so no mixed content).
- **Trade-off:** two GitHub links instead of one. Each repo stays independently cloneable.

---

## Incorrect or weak suggestions that were rejected

1. **Redis as source of truth for holds.** A hold that only exists in Redis can vanish or duplicate across API tasks. Holds are rows with a GiST exclusion and a TTL the database computes.
2. **Pre-generating slots.** Convenient for a calendar widget, forbidden by the assignment, and a storage/consistency problem.
3. **Cookie `Secure` + HSTS on HTTP.** Correct for production TLS; it broke the ALB hostname in browsers (curl still worked).
4. **Ignoring Trivy with `.trivyignore`.** Hides the finding instead of removing the unused npm toolchain from the runtime image.
5. **Deploying without a gated migration.** Schema changes must succeed as a one-shot ECS `RunTask` before new tasks start. A failed migrate must not roll traffic.
6. **Leaving the access JWT valid until expiry after logout.** Refresh revoke is not enough if the Bearer token still works. Session id is checked on authenticate.

---

## How AI output was validated

- Domain invariants were written as tests first where they matter: recurrence math, hold TTL, state machines, authorization.
- Concurrency claims were not trusted from prose. Integration tests hit real Postgres exclusion constraints; a dedicated concurrency suite asserts one winner across parallel holds/confirms/duplicate keys.
- E2E and Postman run through nginx (three replicas), which is the local stand-in for the ALB.
- CDK was synthesised and deployed to a real account; `/health`, `/ready`, `/docs`, and login were smoked against the ALB.
- Secrets never landed in git (`.env`, `.env.aws` are gitignored). JWT material lives in Secrets Manager.

---

## Engineering judgment, compressed

AI is fast at scaffolding and at enumerating alternatives. It is not the source of truth for booking correctness. Postgres is. Every AI suggestion that moved appointment ownership into Redis, the Node process, or “eventually consistent” cache was rejected. The parts that remain — hexagonal modules, outbox, idempotency keys, three stateless tasks — are there because they serve that invariant, not because they look like a senior architecture diagram.
