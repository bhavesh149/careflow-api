#!/bin/bash
# Executed by LocalStack once the SQS service reports ready.
# Creates the same queue topology that CDK provisions in AWS, so the worker code and its
# retry/DLQ behaviour are exercised locally exactly as they will be in production.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-ap-south-1}"

echo "[careflow] creating SQS queues in ${REGION}"

# Dead-letter queue first: the main queue's redrive policy has to reference its ARN.
awslocal sqs create-queue \
  --queue-name careflow-events-dlq \
  --region "${REGION}" \
  --attributes '{"MessageRetentionPeriod":"1209600"}'

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "http://localhost:4566/000000000000/careflow-events-dlq" \
  --attribute-names QueueArn \
  --region "${REGION}" \
  --query 'Attributes.QueueArn' \
  --output text)

# VisibilityTimeout must exceed the consumer's worst-case handling time, otherwise SQS
# redelivers a message that is still being processed and we rely on consumer idempotency
# more often than necessary.
awslocal sqs create-queue \
  --queue-name careflow-events \
  --region "${REGION}" \
  --attributes "$(cat <<JSON
{
  "VisibilityTimeout": "30",
  "MessageRetentionPeriod": "345600",
  "ReceiveMessageWaitTimeSeconds": "20",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"5\"}"
}
JSON
)"

echo "[careflow] SQS queues ready:"
awslocal sqs list-queues --region "${REGION}"
