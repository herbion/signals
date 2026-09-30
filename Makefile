.PHONY: help install test build dev dev-backend dev-frontend up up-build build-docker down restart logs logs-backend logs-signal clean backup-db


# Default target
.DEFAULT_GOAL := help

help: ## Display this help message
	@echo "OpenProject <-> Signal Bridge Makefile"
	@echo "======================================"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

## Dependency & Build Targets
install: ## Install root, backend, and frontend dependencies
	npm install

build: ## Build frontend production bundle into frontend/dist
	npm run build:frontend

## Testing & Quality
test: ## Run backend unit & integration test suite
	npm test --workspace backend

## Local Development (without Docker)
dev-backend: ## Run backend dev server on port 3000
	npm run dev:backend

dev-frontend: ## Run frontend dev server on port 5173 (proxies /api to 3000)
	npm run dev:frontend

## Docker Stack Management
up: ## Start the full Docker Compose stack (app-backend + signal-api)
	docker compose up -d

up-build: ## Build images and start the Docker Compose stack
	docker compose up -d --build

build-docker: ## Build Docker images without starting containers
	docker compose build

down: ## Stop and remove Docker Compose containers
	docker compose down


restart: ## Restart Docker Compose services
	docker compose restart

logs: ## Follow all Docker Compose service logs
	docker compose logs -f

logs-backend: ## Follow app-backend logs
	docker compose logs -f app-backend

logs-signal: ## Follow signal-api logs
	docker compose logs -f signal-api

## Maintenance & Database Utilities
backup-db: ## Force SQLite WAL checkpoint and copy app.db safely
	@mkdir -p backups
	docker compose exec app-backend node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/app.db').prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()"
	docker compose cp app-backend:/data/app.db backups/app-$$(date +%Y%m%d%H%M%S).db
	@echo "Database backup saved to backups/"

clean: ## Clean build artifacts and temporary files
	rm -rf frontend/dist backups
