#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# End-to-end smoke test against a running stack (default: nginx on :8080).
#
# This is the "is the deployment actually working?" check, not a substitute for the test suite.
# It walks the real booking journey through the load balancer, so it exercises three API tasks,
# Postgres, Redis and the queue exactly as a client would, and it is the same script the CI
# pipeline runs after a deploy.
#
# Usage: ./scripts/smoke.sh [base-url]
# ---------------------------------------------------------------------------
set -euo pipefail

BASE="${1:-http://localhost:8080}"
PATIENT_EMAIL="${PATIENT_EMAIL:-patient@careflow.test}"
THERAPIST_EMAIL="${THERAPIST_EMAIL:-dr.mehta@careflow.test}"
PASSWORD="${DEMO_PASSWORD:-Careflow!2026}"

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

jqr() { echo "$1" | jq -r "$2"; }

# ---------------------------------------------------------------------------
step "System endpoints"
curl -fsS "$BASE/health" >/dev/null && pass "GET /health"
READY=$(curl -fsS "$BASE/ready")
[ "$(jqr "$READY" .status)" = "ready" ] && pass "GET /ready reports ready" || fail "not ready: $READY"
curl -fsS "$BASE/metrics" | grep -q careflow_http_requests_total && pass "GET /metrics exposes counters"

# ---------------------------------------------------------------------------
step "Authentication"
LOGIN=$(curl -fsS -X POST "$BASE/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$PATIENT_EMAIL\",\"password\":\"$PASSWORD\"}")
PATIENT_TOKEN=$(jqr "$LOGIN" .accessToken)
[ -n "$PATIENT_TOKEN" ] && pass "patient login returns an access token" || fail "no token"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$PATIENT_EMAIL\",\"password\":\"wrong-password\"}")
[ "$STATUS" = "401" ] && pass "wrong password is rejected with 401" || fail "expected 401, got $STATUS"

ME=$(curl -fsS "$BASE/v1/me" -H "authorization: Bearer $PATIENT_TOKEN")
[ "$(jqr "$ME" .role)" = "PATIENT" ] && pass "GET /v1/me identifies the caller" || fail "bad /me: $ME"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/me")
[ "$STATUS" = "401" ] && pass "unauthenticated request is rejected" || fail "expected 401, got $STATUS"

THERAPIST_LOGIN=$(curl -fsS -X POST "$BASE/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$THERAPIST_EMAIL\",\"password\":\"$PASSWORD\"}")
THERAPIST_TOKEN=$(jqr "$THERAPIST_LOGIN" .accessToken)
[ -n "$THERAPIST_TOKEN" ] && pass "therapist login succeeds" || fail "therapist login failed"

# ---------------------------------------------------------------------------
step "Authorization"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/therapists/me/schedule" \
  -H "authorization: Bearer $PATIENT_TOKEN")
[ "$STATUS" = "403" ] && pass "patient cannot read a therapist schedule" || fail "expected 403, got $STATUS"

SCHEDULE=$(curl -fsS "$BASE/v1/therapists/me/schedule" -H "authorization: Bearer $THERAPIST_TOKEN")
[ "$(echo "$SCHEDULE" | jq '.rules | length')" -gt 0 ] && pass "therapist reads own schedule" \
  || fail "empty schedule: $SCHEDULE"

# ---------------------------------------------------------------------------
step "Availability"
THERAPISTS=$(curl -fsS "$BASE/v1/therapists" -H "authorization: Bearer $PATIENT_TOKEN")
THERAPIST_ID=$(jqr "$THERAPISTS" '.therapists[0].id')
[ -n "$THERAPIST_ID" ] && pass "GET /v1/therapists lists therapists" || fail "no therapists"

FROM=$(date -u +%Y-%m-%d)
TO=$(date -u -v+13d +%Y-%m-%d 2>/dev/null || date -u -d '+13 days' +%Y-%m-%d)
AVAIL=$(curl -fsS "$BASE/v1/therapists/$THERAPIST_ID/availability?from=$FROM&to=$TO" \
  -H "authorization: Bearer $PATIENT_TOKEN")
SLOT_COUNT=$(echo "$AVAIL" | jq '.slots | length')
[ "$SLOT_COUNT" -gt 0 ] && pass "availability returns $SLOT_COUNT bookable slots" || fail "no slots: $AVAIL"

SLOT=$(jqr "$AVAIL" '.slots[0].startTime')
pass "first bookable slot: $SLOT"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  "$BASE/v1/therapists/$THERAPIST_ID/availability?from=$FROM&to=2030-01-01" \
  -H "authorization: Bearer $PATIENT_TOKEN")
[ "$STATUS" = "400" ] && pass "an over-wide date range is rejected" || fail "expected 400, got $STATUS"

# ---------------------------------------------------------------------------
step "Holds"
HOLD=$(curl -fsS -X POST "$BASE/v1/holds" -H "authorization: Bearer $PATIENT_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"therapistId\":\"$THERAPIST_ID\",\"startTime\":\"$SLOT\"}")
HOLD_ID=$(jqr "$HOLD" .id)
[ -n "$HOLD_ID" ] && pass "hold created, expires at $(jqr "$HOLD" .expiresAt)" || fail "no hold: $HOLD"
[ "$(jqr "$HOLD" .expiresInSeconds)" -gt 0 ] && pass "hold reports remaining seconds against server time"

ACTIVE=$(curl -fsS "$BASE/v1/holds/active" -H "authorization: Bearer $PATIENT_TOKEN")
[ "$(echo "$ACTIVE" | jq '.holds | length')" -ge 1 ] && pass "active hold survives a page refresh" \
  || fail "hold not listed: $ACTIVE"

# A second patient must lose the race for the same slot.
P2_TOKEN=$(curl -fsS -X POST "$BASE/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"patient2@careflow.test\",\"password\":\"$PASSWORD\"}" | jq -r .accessToken)
CONFLICT=$(curl -s -w '\n%{http_code}' -X POST "$BASE/v1/holds" -H "authorization: Bearer $P2_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"therapistId\":\"$THERAPIST_ID\",\"startTime\":\"$SLOT\"}")
CODE=$(echo "$CONFLICT" | tail -1)
BODY=$(echo "$CONFLICT" | sed '$d')
[ "$CODE" = "409" ] && pass "a competing hold is refused: $(jqr "$BODY" .error.code)" \
  || fail "expected 409, got $CODE"

# ---------------------------------------------------------------------------
step "Confirmation and idempotency"
KEY=$(uuidgen)
CONFIRM=$(curl -fsS -X POST "$BASE/v1/appointments/confirm" -H "authorization: Bearer $PATIENT_TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: $KEY" \
  -d "{\"holdId\":\"$HOLD_ID\"}")
APPT_ID=$(jqr "$CONFIRM" .id)
[ -n "$APPT_ID" ] && pass "appointment confirmed: $APPT_ID" || fail "confirm failed: $CONFIRM"

REPLAY=$(curl -fsS -X POST "$BASE/v1/appointments/confirm" -H "authorization: Bearer $PATIENT_TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: $KEY" \
  -d "{\"holdId\":\"$HOLD_ID\"}")
[ "$(jqr "$REPLAY" .id)" = "$APPT_ID" ] && pass "retry with the same key replays, not double-books" \
  || fail "replay returned a different appointment"

MISMATCH=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/appointments/confirm" \
  -H "authorization: Bearer $PATIENT_TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: $KEY" -d "{\"holdId\":\"$(uuidgen)\"}")
[ "$MISMATCH" = "422" ] && pass "key reuse with a different body is refused" \
  || fail "expected 422, got $MISMATCH"

# The slot must now be gone from availability.
AVAIL2=$(curl -fsS "$BASE/v1/therapists/$THERAPIST_ID/availability?from=$FROM&to=$TO" \
  -H "authorization: Bearer $PATIENT_TOKEN")
echo "$AVAIL2" | jq -e --arg s "$SLOT" '[.slots[].startTime] | index($s) == null' >/dev/null \
  && pass "the booked slot is no longer offered" || fail "booked slot still offered"

LIST=$(curl -fsS "$BASE/v1/patients/me/appointments?status=UPCOMING" -H "authorization: Bearer $PATIENT_TOKEN")
echo "$LIST" | jq -e --arg id "$APPT_ID" '[.appointments[].id] | index($id) != null' >/dev/null \
  && pass "appointment appears in the patient's list" || fail "not listed: $LIST"

T_LIST=$(curl -fsS "$BASE/v1/therapists/me/appointments" -H "authorization: Bearer $THERAPIST_TOKEN")
echo "$T_LIST" | jq -e --arg id "$APPT_ID" '[.appointments[].id] | index($id) != null' >/dev/null \
  && pass "appointment appears in the therapist's list" || fail "not listed for therapist"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/appointments/$APPT_ID" \
  -H "authorization: Bearer $P2_TOKEN")
[ "$STATUS" = "403" ] && pass "an unrelated patient cannot read the appointment" \
  || fail "expected 403, got $STATUS"

# ---------------------------------------------------------------------------
step "Recurring series"
SLOT2=$(jqr "$AVAIL2" '.slots[0].startTime')
KEY=$(uuidgen)
SERIES=$(curl -fsS -X POST "$BASE/v1/recurring-series" -H "authorization: Bearer $PATIENT_TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: $KEY" \
  -d "{\"therapistId\":\"$THERAPIST_ID\",\"startTime\":\"$SLOT2\",\"frequency\":\"WEEKLY\",\"occurrences\":4}")
SERIES_ID=$(jqr "$SERIES" .id)
COUNT=$(echo "$SERIES" | jq '.appointments | length')
[ -n "$SERIES_ID" ] && pass "weekly series created with $COUNT occurrences" || fail "series failed: $SERIES"

INSTANCE_ID=$(jqr "$SERIES" '.appointments[1].id')
KEY=$(uuidgen)
CANCELLED=$(curl -fsS -X POST \
  "$BASE/v1/recurring-series/$SERIES_ID/instances/$INSTANCE_ID/cancel" \
  -H "authorization: Bearer $PATIENT_TOKEN" -H "idempotency-key: $KEY")
[ "$(jqr "$CANCELLED" .status)" = "CANCELLED" ] && pass "one occurrence cancelled" \
  || fail "instance cancel failed: $CANCELLED"

AFTER=$(curl -fsS "$BASE/v1/recurring-series/$SERIES_ID" -H "authorization: Bearer $PATIENT_TOKEN")
[ "$(jqr "$AFTER" .status)" = "ACTIVE" ] && pass "the series itself is still ACTIVE" \
  || fail "series was cancelled by an instance cancel"
STILL=$(echo "$AFTER" | jq '[.appointments[] | select(.status == "SCHEDULED")] | length')
[ "$STILL" = "$((COUNT - 1))" ] && pass "$STILL sibling occurrences untouched" \
  || fail "expected $((COUNT - 1)) scheduled, found $STILL"

KEY=$(uuidgen)
SERIES_CANCEL=$(curl -fsS -X POST "$BASE/v1/recurring-series/$SERIES_ID/cancel" \
  -H "authorization: Bearer $PATIENT_TOKEN" -H "idempotency-key: $KEY")
pass "series cancelled, $(jqr "$SERIES_CANCEL" .cancelledCount) future occurrences released"

# ---------------------------------------------------------------------------
step "Cancellation"
KEY=$(uuidgen)
CANCEL=$(curl -fsS -X POST "$BASE/v1/appointments/$APPT_ID/cancel" \
  -H "authorization: Bearer $PATIENT_TOKEN" -H "idempotency-key: $KEY")
[ "$(jqr "$CANCEL" .status)" = "CANCELLED" ] && pass "appointment cancelled" || fail "cancel failed: $CANCEL"

AVAIL3=$(curl -fsS "$BASE/v1/therapists/$THERAPIST_ID/availability?from=$FROM&to=$TO" \
  -H "authorization: Bearer $PATIENT_TOKEN")
echo "$AVAIL3" | jq -e --arg s "$SLOT" '[.slots[].startTime] | index($s) != null' >/dev/null \
  && pass "the cancelled slot is bookable again" || fail "slot not released"

# ---------------------------------------------------------------------------
step "Documentation"
curl -fsS "$BASE/docs/json" | jq -e '.paths | keys | length > 10' >/dev/null \
  && pass "OpenAPI document is served with all paths" || fail "openapi document missing"

printf '\n\033[32mAll smoke checks passed against %s\033[0m\n\n' "$BASE"
