# API guide

Two ways to explore the API, both generated from the same source as the running code.

| Surface           | Where                                              | Use it for                                       |
| ----------------- | -------------------------------------------------- | ------------------------------------------------ |
| Swagger UI        | <http://localhost:8080/docs>                       | Browsing the contract, trying single requests     |
| OpenAPI document  | <http://localhost:8080/docs/json>, `docs/api/openapi.json` | Client generation, contract diffing in CI |
| Postman / newman  | `docs/postman/`                                    | Running the whole booking journey with assertions |

## Why the docs cannot drift

Every route declares one Zod schema, and that schema is used for three things at once: validating
the incoming request, serialising the response, and generating the OpenAPI document. There is no
second, hand-written description of the API to fall out of date — if a field is documented, the
running service enforces it, and if validation changes, the document changes with it.

`npm run openapi:export` writes the document to `docs/api/openapi.json`. It needs no database or
Redis (building the application performs no I/O), so CI regenerates it and fails on a diff. A
change to the API contract therefore shows up as a reviewable file change rather than as a
surprise for a client team.

## Authentication

```bash
curl -sX POST http://localhost:8080/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"patient@careflow.test","password":"Careflow!2026"}'
```

The response body carries a 15-minute access token; the refresh token is set as an `httpOnly`
cookie and is deliberately not readable by JavaScript. Send the access token as
`Authorization: Bearer <token>`. In Swagger UI, click **Authorize** and paste the token once.

`POST /v1/auth/refresh` rotates the refresh token using only the cookie. Each refresh revokes its
predecessor, so replaying an old token is detected as theft and revokes the whole family — the
user is logged out everywhere, which is the correct response to a stolen token.

Seeded accounts (local only, password `Careflow!2026`):

| Account                  | Role      |
| ------------------------ | --------- |
| `patient@careflow.test`  | PATIENT   |
| `patient2@careflow.test` | PATIENT   |
| `patient3@careflow.test` | PATIENT   |
| `dr.mehta@careflow.test` | THERAPIST |
| `dr.rao@careflow.test`   | THERAPIST |
| `dr.iyer@careflow.test`  | THERAPIST |

## Idempotency

Every state-changing endpoint accepts an `Idempotency-Key` header, and the booking endpoints
require one. Use a fresh UUID per logical operation and reuse it verbatim when retrying:

```bash
KEY=$(uuidgen)
curl -sX POST http://localhost:8080/v1/appointments/confirm \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H "idempotency-key: $KEY" \
  -d "{\"holdId\":\"$HOLD_ID\"}"
```

| Situation                                  | Response                                     |
| ------------------------------------------ | -------------------------------------------- |
| First call                                 | `201` with the appointment                   |
| Retry, same key, same body                 | `201` replayed from the stored response       |
| Retry while the first is still in flight   | `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After` |
| Same key, different body                   | `422 IDEMPOTENCY_KEY_REUSED`                  |

The record lives in Postgres, not in process memory, so all three API tasks agree — a retry that
lands on a different task than the original still replays rather than double-books.

## Errors

Every failure uses one envelope, including rate limiting and validation:

```json
{
  "error": {
    "code": "SLOT_ALREADY_HELD",
    "message": "The selected slot is currently held.",
    "requestId": "0f1c…",
    "details": { "startTime": "…", "endTime": "…" }
  }
}
```

`requestId` is echoed in the `X-Request-Id` response header and stamped on every server log line
for that request, so a user-reported failure can be traced without guesswork. `X-Instance-Id`
shows which task answered.

Conflicts are worth calling out because they are normal traffic, not faults:

| Code                  | Status | Meaning                                                         |
| --------------------- | ------ | --------------------------------------------------------------- |
| `SLOT_ALREADY_HELD`   | 409    | Another patient holds the slot right now                        |
| `APPOINTMENT_CONFLICT`| 409    | The slot was booked before this request committed               |
| `RECURRING_CONFLICT`  | 409    | At least one occurrence clashes; **nothing** was booked, and the response lists every clash |
| `HOLD_EXPIRED`        | 409    | The hold's TTL lapsed before confirmation                       |

## Running the Postman collection

Import `docs/postman/Careflow.postman_collection.json` and
`docs/postman/Careflow.local.postman_environment.json`, then run the collection top to bottom.
Requests are ordered as a real journey and each one captures what the next needs, so no ids or
tokens are ever copied by hand:

- A collection-level pre-request script generates a fresh `Idempotency-Key` for every request and
  computes the availability date window, so the collection does not rot as dates pass.
- Login requests capture their access tokens into collection variables.
- The **Conflict race** folder logs in a second patient and asserts the deterministic `409` for a
  slot the first patient holds.
- The **Booking** folder deliberately reuses one key twice: once with the same body (must replay)
  and once with a different body (must be refused).

Every request has assertions, so the collection is also a contract test:

```bash
npm run test:api
# or directly:
newman run docs/postman/Careflow.postman_collection.json \
  -e docs/postman/Careflow.local.postman_environment.json
```

Because the run books and cancels real appointments, re-run `npm run db:seed` (or `make seed`) if you want a pristine dataset afterwards.

## Shape of the API

| Area              | Endpoints                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Auth              | `POST /v1/auth/login`, `/refresh`, `/logout`, `GET /v1/me`                                            |
| Therapists        | `GET /v1/therapists`, `GET|PUT /v1/therapists/me/schedule`                                            |
| Availability      | `GET /v1/therapists/{id}/availability?from=&to=`                                                      |
| Holds             | `POST /v1/holds`, `GET /v1/holds/active`, `DELETE /v1/holds/{id}`                                      |
| Appointments      | `POST /v1/appointments/confirm`, `GET /v1/patients/me/appointments`, `GET /v1/therapists/me/appointments`, `GET /v1/appointments/{id}`, `POST /v1/appointments/{id}/cancel`, `POST /v1/appointments/{id}/status` |
| Recurring series  | `POST /v1/recurring-series`, `GET /v1/recurring-series/{id}`, `POST /v1/recurring-series/{id}/cancel`, `POST /v1/recurring-series/{id}/instances/{instanceId}/cancel` |
| System            | `GET /health`, `GET /ready`, `GET /metrics`                                                            |

Cancellation is a `POST .../cancel` rather than a `DELETE` because it is a state transition, not a
deletion: the appointment stays in history with `status = CANCELLED`, which is what the therapist's
records and any later audit need.
