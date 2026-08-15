#!/usr/bin/env bash
# Create or update Secrets Manager `careflow/jwt` from `.env.aws`.
# Prints only the secret ARN (safe to put in cdk.json). Never prints the JWT.
set -euo pipefail

PROFILE="${AWS_PROFILE:-careflow}"
REGION="${AWS_REGION:-ap-south-1}"
SECRET_NAME="${SECRET_NAME:-careflow/jwt}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.aws}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

JWT_SECRET="$(awk -F= '/^JWT_SECRET=/{print substr($0, index($0,$2))}' "$ENV_FILE")"
if [ "${#JWT_SECRET}" -lt 32 ]; then
  echo "JWT_SECRET in $ENV_FILE is missing or shorter than 32 characters." >&2
  exit 1
fi
if [[ "$JWT_SECRET" == local_dev_only* ]]; then
  echo "Refusing to upload the local development JWT secret." >&2
  exit 1
fi

ARN="$(aws --profile "$PROFILE" --region "$REGION" secretsmanager describe-secret \
  --secret-id "$SECRET_NAME" --query ARN --output text 2>/dev/null || true)"

if [ -z "$ARN" ] || [ "$ARN" = 'None' ]; then
  ARN="$(aws --profile "$PROFILE" --region "$REGION" secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --description 'Careflow JWT signing secret (plain string, not JSON)' \
    --secret-string "$JWT_SECRET" \
    --query ARN --output text)"
  echo "Created $SECRET_NAME"
else
  aws --profile "$PROFILE" --region "$REGION" secretsmanager put-secret-value \
    --secret-id "$SECRET_NAME" \
    --secret-string "$JWT_SECRET" >/dev/null
  echo "Updated $SECRET_NAME"
fi

echo "ARN=$ARN"
