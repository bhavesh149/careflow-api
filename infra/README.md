# Careflow AWS CDK

CDK v2 app for the booking backend. Entry: [`bin/app.ts`](bin/app.ts). Stack:
[`lib/careflow-stack.ts`](lib/careflow-stack.ts).

This stack is sized for a **few-day showcase**: HTTP ALB (no domain), 3 API tasks, one of
each worker, `db.t4g.micro` Postgres 17, `cache.t4g.micro` Redis, no NAT Gateway. Tear it
down with `make aws-destroy` when you are done.

Account, IAM OIDC, GitHub secret, ACM: [`../docs/05-aws-first-deploy.md`](../docs/05-aws-first-deploy.md).

```bash
export AWS_PROFILE=careflow
make aws-bootstrap    # once per account/region
make aws-deploy       # builds linux/amd64 image, creates RDS/ECS/ALB (~15–20 min)
make aws-migrate      # schema + demo seed
```

The Deploy workflow expects these CloudFormation outputs on stack `Careflow`:

- `ClusterName`
- `MigrateTaskDefinitionFamily`
- `IsolatedSubnetIds` (public subnets in this showcase; tasks use a public IP)
- `TaskSecurityGroupId`
- `ApiUrl`

Context flags: `imageTag` (`latest` builds from the Dockerfile; CI passes a git SHA after
pushing to ECR), `certificateArn` (optional HTTPS), `corsOrigins`, `region` (`ap-south-1`).
