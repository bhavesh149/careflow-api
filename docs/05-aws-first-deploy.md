# AWS first deploy — from a brand-new account

This is the playbook for putting Careflow on AWS. It starts from “I have never created an AWS
service before” and ends at a running ALB URL.

Region used everywhere: **`ap-south-1` (Mumbai)**.

## Showcase path (3–4 days, no domain)

The CDK stack is in `infra/lib/careflow-stack.ts`. It creates HTTP ALB (use the DNS name
directly), **3 API tasks**, one of each worker, small RDS + Redis, no NAT Gateway.

Rough cost for four days: **about $15–25**. Destroy with `make aws-destroy` when you are done.

### 1. Give `bhavesh-admin` permission to deploy

The CLI profile `careflow` is `arn:aws:iam::853184314326:user/bhavesh-admin`. That user currently
cannot call CloudFormation, so bootstrap/deploy will fail until you attach a broad policy.

Sign in to the AWS console as the **root** user (or any user that already has IAM admin):

1. **IAM → Users → bhavesh-admin → Add permissions → Attach policies directly**
2. Search **`AdministratorAccess`** → tick it → Next → Add permissions

For a few-day take-home this is the right policy. You can detach it after `make aws-destroy`.

### 2. Bootstrap, secrets, deploy, seed

From the backend folder, with Docker Desktop running:

```bash
export AWS_PROFILE=careflow
make aws-bootstrap    # once per account/region (~1 min)
make aws-secrets      # uploads JWT_SECRET from .env.aws to Secrets Manager careflow/jwt
make aws-deploy       # builds linux/amd64 image + RDS/ECS/ALB (~15–20 min)
make aws-migrate      # schema + demo accounts
```

`aws-deploy` prints `ApiUrl`. Open `http://<alb-dns>/docs`. Seeded password: `Careflow!2026`.

There is no HTTPS and no custom domain. Login from Swagger: copy `accessToken` into
**Authorize**. Refresh cookies may not stick on plain HTTP; the 15-minute access token is enough
for a demo.

When the showcase is over:

```bash
make aws-destroy
```

---

## What you create by hand vs what CDK creates

You do **not** click around the ECS / RDS / SQS consoles to build the product. CDK is the source
of truth for those. If you create them by hand, the next `cdk deploy` will fight you.

| You create (once, in the console or CLI) | CDK creates (every environment) |
| --- | --- |
| AWS account | VPC: public subnets for ALB + Fargate, isolated subnets for RDS/Redis (no NAT) |
| IAM user with **AdministratorAccess** (needed for `cdk bootstrap` / deploy) | Amazon RDS PostgreSQL 17 (`db.t4g.micro`, single-AZ) |
| Optional later: GitHub OIDC + `AWS_DEPLOY_ROLE_ARN` | ElastiCache Redis (`cache.t4g.micro`) |
| Optional later: ACM certificate for HTTPS | SQS queue + DLQ |
| CDK bootstrap (`make aws-bootstrap`) | ECR repository `careflow` |
| | ALB HTTP (HTTPS only if you pass `certificateArn`) |
| | ECS Fargate: API **desired count 3**, three worker services, migration task |
| | Secrets Manager (JWT + RDS password) |
| | CloudWatch logs (7-day retention) |

Runtime env vars on ECS are **not** a `.env` file. The task definition injects the same names
from Secrets Manager and plain environment. Tasks authenticate to AWS with their **task role**,
not with `AWS_ACCESS_KEY_ID`.

---

## 0. Cost warning

This stack is a real production shape, not a free-tier toy. Expect ongoing cost from:

- RDS (smallest useful class is still billed hourly)
- 3 API tasks + 3 worker tasks on Fargate
- ElastiCache
- Interface VPC endpoints (several endpoints, hourly + data)
- ALB
- NAT is **intentionally omitted** to avoid that bill; endpoints replace it

Destroy the stack (`npx cdk destroy Careflow` from `infra/`) when you are not using it.

---

## 1. Create the AWS account and lock down the root user

1. Sign up at [https://aws.amazon.com](https://aws.amazon.com).
2. Confirm the email, add a payment method, choose **Mumbai (`ap-south-1`)** in the console
   region picker (top-right).
3. Enable MFA on the **root** user (IAM → Dashboard → “Add MFA”).
4. Do **not** use the root user after this. Create a human admin:

   **IAM → Users → Create user**

   - User name: `careflow-admin` (or your name).
   - Enable **console access**.
   - Attach AWS managed policy **`AdministratorAccess`** for the first setup (tighten later).
   - Create an access key only if you will run CDK from your laptop
     (`Access key` → “Command Line Interface”). Store the key id and secret in
     `~/.aws/credentials` as profile `careflow`:

     ```ini
     [careflow]
     aws_access_key_id = AKIA...
     aws_secret_access_key = ...
     ```

     ```ini
     # ~/.aws/config
     [profile careflow]
     region = ap-south-1
     output = json
     ```

   Verify:

   ```bash
   aws sts get-caller-identity --profile careflow
   ```

   You should see your **12-digit account id**. Copy it; every ARN below uses it. In this doc
   it is written `111122223333`.

---

## 2. Create the GitHub repository the right way

GitHub Actions only sees `.github/workflows/` at the **repository root**. This backend folder
*is* that root. Do **not** push the parent `CAREFLOW/` folder if you want CI to run.

From this directory (the folder that contains `package.json`, `docker-compose.yml`, and
`.github/`):

```bash
git init
git add .
git commit -m "Initial Careflow backend"
# then create the empty GitHub repo in the UI and:
git remote add origin git@github.com:YOUR_ORG/careflow-backend.git
git branch -M main
git push -u origin main
```

Replace `YOUR_ORG/careflow-backend` everywhere below with the real `owner/repo`.

PR checks (typecheck, tests, image build) work with **no AWS credentials**. The Deploy workflow
needs the role from the next two steps.

---

## 3. GitHub OIDC — so Actions never stores AWS keys

GitHub Actions will **assume an IAM role** using a short-lived token. There is no long-lived
`AWS_ACCESS_KEY_ID` in GitHub.

### 3a. Identity provider (once per AWS account)

**IAM → Identity providers → Add provider**

- Provider type: **OpenID Connect**
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`
- Add provider. AWS fetches the thumbprint.

If it already exists (from another project), reuse it. One OIDC provider per account is enough.

### 3b. Deploy role

**IAM → Roles → Create role**

1. Trusted entity: **Web identity**.
2. Identity provider: `token.actions.githubusercontent.com`.
3. Audience: `sts.amazonaws.com`.
4. Add condition (or edit the trust policy after create) so **only this repo** can assume it.

Trust policy (replace account, org, and repo):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/careflow-backend:*"
        }
      }
    }
  ]
}
```

`sub` with `repo:ORG/REPO:*` allows every branch and every `workflow_dispatch`. Tighten to
`repo:YOUR_ORG/careflow-backend:ref:refs/heads/main` if you only want `main` to deploy.

5. Role name: `CareflowGitHubDeploy`.
6. Permissions: for a take-home first deploy, attach **`AdministratorAccess`**. That is broad on
   purpose so CDK can create IAM roles, VPCs, and RDS. After the stack exists, replace it with a
   scoped policy (CloudFormation, ECS, ECR, RDS, EC2, IAM PassRole on Careflow roles only, etc.).

Copy the role ARN. It looks like:

```text
arn:aws:iam::111122223333:role/CareflowGitHubDeploy
```

That string is the **only** GitHub secret the Deploy workflow needs.

---

## 4. Put the GitHub secret

In the GitHub repo:

**Settings → Secrets and variables → Actions → New repository secret**

| Name | Value | Where it is used |
| --- | --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::111122223333:role/CareflowGitHubDeploy` | `.github/workflows/deploy.yml` (`role-to-assume`) |

There is no second GitHub secret for the database password or JWT. Those live in **AWS Secrets
Manager**, created by CDK, read by ECS.

Do **not** put `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in GitHub.

---

## 5. Where every secret comes from, and where it goes

Three stores. Mixing them up is the usual failure mode.

```text
You generate a value
        │
        ├─► GitHub Actions secret     (only the deploy role ARN)
        ├─► AWS Secrets Manager       (what the running API reads)
        └─► CDK context / CLI flag    (non-secret deploy inputs: image tag, cert ARN)
```

### 5a. GitHub Actions (deploy credentials only)

| Secret | How you get it | Where you put it |
| --- | --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | IAM role ARN from step 3b | GitHub → Settings → Secrets |

### 5b. You generate on your laptop (app crypto)

```bash
openssl rand -base64 64
```

That output is `JWT_SECRET`. It must be at least 32 characters and must **not** start with
`local_dev_only` (the process refuses to boot in production if it does).

| Value | How you get it | Where it ends up |
| --- | --- | --- |
| `JWT_SECRET` | `openssl rand -base64 64` | AWS Secrets Manager, secret the CDK stack will create (e.g. `careflow/jwt`). CDK injects it into the task as env `JWT_SECRET`. **Never** commit it. **Never** put it in GitHub secrets. |
| Demo user passwords | You choose; local seed uses `Careflow!2026` | Production should **not** run the local seed. Create real users through a one-off admin path or a production seed you control. |

Until `careflow-stack.ts` exists, generate the JWT value and keep it in a password manager. You
paste it into the Secrets Manager secret the first time the stack creates an empty placeholder,
or the stack can generate it (`generateSecretString`) so you never see it — either is fine.
Rotating JWT invalidates every access token; refresh cookies still work only if you keep the
same secret.

### 5c. AWS generates (you never invent these)

| Value | How you get it | Where it ends up |
| --- | --- | --- |
| RDS master password | RDS / Secrets Manager generates on create | Secrets Manager (CDK `DatabaseSecret`). Used to build `MIGRATION_DATABASE_URL`. |
| App DB password (`careflow_app`) | You (or CDK) `CREATE ROLE` during migration; store the password in Secrets Manager | `DATABASE_URL` for API and workers. The API must **not** use the RDS master user. |
| Redis auth token | ElastiCache / CDK generates | `REDIS_URL` |
| SQS queue URL | SQS create | `SQS_QUEUE_URL` (plain env, not a secret — it is not a credential) |
| ECR image URI | `docker push` in CI | ECS task definition `image` |

`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `SQS_ENDPOINT` are **local-only** (LocalStack).
In AWS, leave them unset. The SDK uses the task role and the real regional endpoint.

### 5d. Not secrets — CDK context and env on the task

These are configuration. Safe to pass as `--context` or non-secret task environment.

| Name | How you get it | Where you put it |
| --- | --- | --- |
| `imageTag` | Git SHA (CI already sets this) | `npx cdk deploy --context imageTag=$GITHUB_SHA` |
| `certificateArn` | ACM (step 6) | `--context certificateArn=arn:aws:acm:ap-south-1:111122223333:certificate/...` |
| `corsOrigins` | Your frontend origin, e.g. `https://app.example.com` | `--context corsOrigins=https://app.example.com` → task env `CORS_ORIGINS` |
| `COOKIE_SECURE` | Always `true` in production | Task env (hard-coded in the stack) |
| `COOKIE_DOMAIN` | API parent domain if cookies are shared, else empty | Task env |
| `SWAGGER_ENABLED` | `false` unless you deliberately want `/docs` public | Task env |
| `QUEUE_DRIVER` | `sqs` | Task env |
| `AWS_REGION` | `ap-south-1` | Task env |
| `NODE_ENV` | `production` | Task env |

The full name list the process reads is [`.env.example`](../.env.example). Production must
satisfy the extra checks in `src/shared/config/env.ts`: `COOKIE_SECURE=true`, explicit
`CORS_ORIGINS` with no `*`, and a real `JWT_SECRET`.

### 5e. ACM certificate (HTTPS on the ALB)

1. Own a domain (Route 53 or any registrar).
2. **Certificate Manager** in **`ap-south-1`** (not `us-east-1`) → Request certificate →
   **public** → domain `api.yourdomain.com` (and optionally `*.yourdomain.com`).
3. Validation: DNS. If the domain is in Route 53, click **Create records**. Otherwise copy the
   CNAME to your DNS host. Wait until status is **Issued**.
4. Copy the certificate ARN. That is `certificateArn`.

Without it, the stack is designed to synth and can deploy an **HTTP** listener so CI can run
`cdk synth` before a domain exists. Do not put a public booking API on HTTP.

Point DNS at the ALB **after** the first deploy, using the stack output `ApiUrl` / the ALB DNS
name. Create an alias `api.yourdomain.com` → that ALB.

---

## 6. Bootstrap CDK in the account (once)

On your laptop, from this repo:

```bash
cd infra
npm ci
export AWS_PROFILE=careflow
export CDK_DEFAULT_ACCOUNT=111122223333
export CDK_DEFAULT_REGION=ap-south-1
npx cdk bootstrap aws://111122223333/ap-south-1
```

This creates the `CDKToolkit` stack (an S3 bucket and roles CDK itself uses). It is not the
Careflow stack.

`npx cdk synth` / `npx cdk deploy` will fail until `infra/lib/careflow-stack.ts` exists. That
file is the remaining backend coding work.

---

## 7. First deploy order (after the stack is implemented)

Chicken-and-egg: CI wants an ECR repo and an ECS cluster that do not exist yet.

1. Implement `infra/lib/careflow-stack.ts` so it creates ECR, the cluster, RDS, etc., and
   CloudFormation outputs matching `.github/workflows/deploy.yml`:

   - `ClusterName`
   - `MigrateTaskDefinitionFamily`
   - `IsolatedSubnetIds`
   - `TaskSecurityGroupId`
   - `ApiUrl`

2. From a laptop, deploy **once** (creates ECR, RDS, empty services or a public image):

   ```bash
   cd infra
   npx cdk deploy Careflow \
     --context imageTag=bootstrap \
     --context certificateArn=arn:aws:acm:ap-south-1:111122223333:certificate/… \
     --context corsOrigins=https://app.yourdomain.com
   ```

3. Put `JWT_SECRET` into the secret CDK created (console: **Secrets Manager → careflow/jwt →
   Retrieve secret value → Edit**), unless the stack generated it for you.

4. Confirm RDS is in isolated subnets, the migrator uses `MIGRATION_DATABASE_URL` (owner), and
   API tasks use `DATABASE_URL` (app role, DML only).

5. Push to `main`. GitHub Actions then: build → push to ECR → **gated** `ecs run-task` for
   migrations (must exit 0) → `cdk deploy` with `imageTag=$GITHUB_SHA` → smoke `/health` and
   `/ready` through the ALB.

If step 5 runs before step 2, the workflow fails looking up stack `Careflow`. That is expected.

---

## 8. After it is up — where to look

| Question | Where |
| --- | --- |
| Is the API up? | Stack output `ApiUrl` + `/health` and `/ready` |
| Did a task crash? | CloudWatch → Log groups `/ecs/careflow-…` |
| Did a deploy roll back? | ECS → service → events (circuit breaker) |
| Did migration fail? | The Deploy workflow “Gated schema migration” job; ECS stopped-task reason |
| What image is running? | ECS → task definition → image tag = git SHA |

Postman against AWS: import `docs/postman/Careflow.aws.postman_environment.json` and set
`baseUrl` to `ApiUrl`.

---

## 9. Checklist (print this)

- [ ] AWS account, MFA on root, admin IAM user, profile `careflow`, region `ap-south-1`
- [ ] GitHub repo is **this backend folder as root** (`.github/workflows` visible at repo root)
- [ ] OIDC provider `token.actions.githubusercontent.com`
- [ ] Role `CareflowGitHubDeploy` whose trust `sub` matches `repo:ORG/REPO:*`
- [ ] GitHub secret `AWS_DEPLOY_ROLE_ARN` = that role’s ARN
- [ ] ACM cert in `ap-south-1` issued (for HTTPS)
- [ ] `cdk bootstrap aws://ACCOUNT/ap-south-1`
- [ ] `JWT_SECRET` generated with `openssl rand -base64 64` and stored only in Secrets Manager
- [ ] `infra/lib/careflow-stack.ts` implemented (not done yet)
- [ ] First laptop `cdk deploy Careflow`
- [ ] DNS alias to the ALB
- [ ] Push to `main` → Deploy workflow green → smoke passes
- [ ] Local seed password **not** used as production auth
