# Careflow developer entrypoints. `make help` lists everything.
# Run these from this directory (the backend repo root).
.DEFAULT_GOAL := help
.PHONY: help up down restart logs ps build migrate seed reset psql redis-cli queues \
        test test-unit test-integration test-concurrency test-e2e test-all \
        lint typecheck format check openapi smoke \
        aws-bootstrap aws-secrets aws-deploy aws-migrate aws-destroy

COMPOSE := docker compose

help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

## ---------------------------------------------------------------- local stack

up: ## Build and start the full local stack (3 API tasks + 3 workers)
	$(COMPOSE) up -d --build
	@echo ""
	@echo "  API (via nginx/ALB) : http://localhost:8080"
	@echo "  Swagger UI          : http://localhost:8080/docs"
	@echo "  Direct tasks        : :3001 :3002 :3003"
	@echo ""

down: ## Stop the stack and remove containers
	$(COMPOSE) down --remove-orphans

restart: ## Restart the API tasks only
	$(COMPOSE) restart api-1 api-2 api-3

logs: ## Tail logs from every service
	$(COMPOSE) logs -f --tail=80

ps: ## Show service status
	$(COMPOSE) ps

build: ## Rebuild images without starting
	$(COMPOSE) build

reset: ## Destroy the stack including the database volume, then start clean
	$(COMPOSE) down -v --remove-orphans
	$(COMPOSE) up -d --build

## ---------------------------------------------------------------- database

migrate: ## Apply pending SQL migrations
	$(COMPOSE) run --rm migrate npm run db:migrate

seed: ## Seed demo therapists, patients and schedules
	$(COMPOSE) run --rm migrate npm run db:seed

psql: ## Open a psql shell as the migration owner
	$(COMPOSE) exec postgres psql -U careflow_owner -d careflow

redis-cli: ## Open a redis shell
	$(COMPOSE) exec redis redis-cli

queues: ## List LocalStack SQS queues and their message counts
	$(COMPOSE) exec localstack awslocal sqs list-queues --region ap-south-1

## ---------------------------------------------------------------- quality

typecheck: ## TypeScript type checking
	npm run typecheck

lint: ## ESLint including hexagonal layering rules
	npm run lint

format: ## Apply Prettier
	npm run format

test-unit: ## Fast pure unit tests
	npm run test:unit

test-integration: ## Repository/transaction tests against real Postgres
	npm run test:integration

test-concurrency: ## Race-condition tests (the highest-value suite)
	npm run test:concurrency

test-e2e: ## Full API journeys
	npm run test:e2e

        test-all: ## Every suite
	npm run test:all

check: typecheck lint test-unit ## What CI runs on a pull request

openapi: ## Export the OpenAPI document to docs/api/openapi.json
	npm run openapi:export

smoke: ## Probe a running stack (health, then a booking journey; needs jq)
	./scripts/smoke.sh

## ---------------------------------------------------------------- aws showcase

        aws-bootstrap: ## One-time CDK bootstrap in ap-south-1
	cd infra && npx cdk bootstrap aws://853184314326/ap-south-1

aws-secrets: ## Create/update Secrets Manager careflow/jwt from .env.aws
	./scripts/aws-put-secrets.sh

aws-deploy: ## Synth and deploy the Careflow stack (builds the AMD64 image)
	cd infra && npx cdk deploy Careflow --require-approval never

aws-migrate: ## Run the ECS migrate+seed task and wait
	./scripts/aws-migrate.sh

aws-destroy: ## Tear down the showcase stack (stops the bill)
	cd infra && npx cdk destroy Careflow --force
