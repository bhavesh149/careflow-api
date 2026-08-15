#!/usr/bin/env bash
# Run the ECS migrate+seed task against the deployed Careflow stack and wait until it exits 0.
set -euo pipefail

PROFILE="${AWS_PROFILE:-careflow}"
REGION="${AWS_REGION:-ap-south-1}"
STACK="${STACK_NAME:-Careflow}"

aws_cli() {
  aws --profile "$PROFILE" --region "$REGION" "$@"
}

output() {
  aws_cli cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

CLUSTER=$(output ClusterName)
FAMILY=$(output MigrateTaskDefinitionFamily)
SUBNETS=$(output IsolatedSubnetIds)
SG=$(output TaskSecurityGroupId)

if [ -z "$CLUSTER" ] || [ "$CLUSTER" = 'None' ]; then
  echo "Stack $STACK is not deployed (missing ClusterName output)." >&2
  exit 1
fi

echo "Running $FAMILY on $CLUSTER (subnets $SUBNETS)"

RUN=$(aws_cli ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$FAMILY" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG}],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)

echo "Migration task $RUN"
aws_cli ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$RUN"

EXIT=$(aws_cli ecs describe-tasks --cluster "$CLUSTER" --tasks "$RUN" \
  --query 'tasks[0].containers[0].exitCode' --output text)

if [ "$EXIT" != '0' ]; then
  echo "Migration failed with exit code $EXIT" >&2
  aws_cli ecs describe-tasks --cluster "$CLUSTER" --tasks "$RUN"
  echo "Logs: /ecs/careflow  stream prefix migrate" >&2
  exit 1
fi

echo "Migrations and seed completed."
API=$(output ApiUrl)
echo "API: $API"
echo "Swagger: $API/docs"
echo "Seeded password: Careflow!2026"
