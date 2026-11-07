# The hosted-plan control app (sign-up, Stripe, instance provisioning). Not the SEOConsole app itself: build from the repo root,
#   docker build -f cloud/Dockerfile -t osc-control .
# Written but NOT built or run in the environment where it was authored (no Docker there).
FROM --platform=linux/amd64 node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm cloud:build && pnpm prune --prod

FROM --platform=linux/amd64 node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 CLOUD_DB_PATH=/data/cloud.db
COPY --from=build /app/cloud/dist ./cloud/dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "cloud/dist/main.js"]
