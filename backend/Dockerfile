FROM node:22-alpine AS base

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/package.json
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile

WORKDIR /app/backend
COPY backend ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["pnpm", "exec", "tsx", "src/start.ts"]
