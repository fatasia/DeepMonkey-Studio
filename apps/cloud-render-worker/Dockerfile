FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts/clean-dir.mjs scripts/clean-dir.mjs
COPY packages/server-sdk/package.json packages/server-sdk/package.json
COPY packages/server-sdk/tsconfig.json packages/server-sdk/tsconfig.json
COPY packages/server-sdk/src packages/server-sdk/src
COPY apps/cloud-render-worker/package.json apps/cloud-render-worker/package.json
COPY apps/cloud-render-worker/tsconfig.json apps/cloud-render-worker/tsconfig.json
COPY apps/cloud-render-worker/src apps/cloud-render-worker/src
RUN pnpm install --frozen-lockfile --filter @bim-studio/cloud-render-worker...
RUN pnpm --filter @bim-studio/server-sdk build && pnpm --filter @bim-studio/cloud-render-worker build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production DISPLAY=:99 CLOUD_RENDER_CHROMIUM_PATH=/usr/bin/chromium CLOUD_RENDER_HEADLESS=false
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb tini fonts-noto-cjk mesa-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/cloud-render-worker/node_modules ./apps/cloud-render-worker/node_modules
COPY --from=build /workspace/packages/server-sdk/package.json ./packages/server-sdk/package.json
COPY --from=build /workspace/packages/server-sdk/dist ./packages/server-sdk/dist
COPY --from=build /workspace/apps/cloud-render-worker/package.json ./apps/cloud-render-worker/package.json
COPY --from=build /workspace/apps/cloud-render-worker/dist ./apps/cloud-render-worker/dist
COPY apps/cloud-render-worker/docker-entrypoint.sh ./apps/cloud-render-worker/docker-entrypoint.sh
RUN chmod +x ./apps/cloud-render-worker/docker-entrypoint.sh
EXPOSE 4200
ENTRYPOINT ["/usr/bin/tini", "--", "/workspace/apps/cloud-render-worker/docker-entrypoint.sh"]
