# Careflow AWS CDK

CDK v2 app for the booking backend. Entry: [`bin/app.ts`](bin/app.ts). Stack:
[`lib/careflow-stack.ts`](lib/careflow-stack.ts).

The stack is sized to the product: HTTP ALB (no custom domain), **3 API tasks**, one of
each worker, `db.t4g.micro` Postgres 17, `cache.t4g.micro` Redis, no NAT Gateway (Fargate
public IP; RDS/Redis isolated). Tear it down with `make aws-destroy` when you no longer need it.

Why each AWS service exists: [`../docs/06-aws-infrastructure.md`](../docs/06-aws-infrastructure.md).

```bash
export AWS_PROFILE=careflow
make aws-bootstrap    # once per account/region
make aws-deploy       # builds linux/amd64 image, creates RDS/ECS/ALB (~15–20 min)
make aws-migrate      # schema + demo seed
```

The Deploy workflow expects these CloudFormation outputs on stack `Careflow`:

- `ClusterName`
- `MigrateTaskDefinitionFamily`
- `IsolatedSubnetIds` (public subnets in this VPC; tasks use a public IP)
- `TaskSecurityGroupId`
- `ApiUrl`

Context flags: `imageTag` (`latest` builds from the Dockerfile; CI passes a git SHA after
pushing to ECR), `certificateArn` (optional HTTPS), `corsOrigins`, `region` (`ap-south-1`).
