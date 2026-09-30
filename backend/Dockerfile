# Build context is the repo root (see docker-compose.yml), so both
# backend/ and frontend/ are visible here.

FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./
# index.js serves this directory as static assets if it exists, and falls
# back to API-only mode (useful for `npm run dev:frontend` against a
# separately-running Vite dev server) if it doesn't.
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
