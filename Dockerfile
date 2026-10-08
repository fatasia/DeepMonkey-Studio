# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM bitnamilegacy/minio@sha256:451fe6858cb770cc9d0e77ba811ce287420f781c7c1b806a386f6896471a349c AS minio-client

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
# CPU inference binaries are bundled; CUDA workers have their own deployment.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN apt-get update && apt-get install --yes --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.18.0
COPY . .
RUN pnpm --filter @bim-studio/api... --filter @bim-studio/web... install --frozen-lockfile
RUN pnpm --filter @bim-studio/api... --filter @bim-studio/web... -r --workspace-concurrency=2 build
# The release pipeline builds WASM before the image. Reject a missing/stale bundle.
RUN node scripts/check-runtime-artifact-freshness.mjs
RUN pnpm --filter @bim-studio/api --prod deploy --legacy /out/apps/api \
    && mkdir -p /out/apps/api/dist && cp -a apps/api/dist/. /out/apps/api/dist/ \
    && rm -rf /out/apps/api/src /out/apps/api/scripts
RUN node scripts/prune-runtime-platforms.mjs /out/apps/api linux x64 \
    && cd /out/apps/api && node -e "require('onnxruntime-node')"

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.2.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Deep Monkey Studio" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="https://github.com/fatasia/DeepMonkey-Studio"
RUN apt-get update && apt-get install --yes --no-install-recommends postgresql-client ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=minio-client /opt/bitnami/minio-client/bin/mc /usr/local/bin/mc
WORKDIR /opt/studio
COPY --from=build --chown=node:node /out/apps/api apps/api
COPY --from=build --chown=node:node /workspace/apps/web/dist apps/web/dist
COPY --from=build /workspace/LICENSE /workspace/LICENSE.zh-CN.md /workspace/LICENSING.md /workspace/THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /var/lib/studio && chown node:node /var/lib/studio
RUN dpkg-query -W > /opt/studio/DEPENDENCIES.txt
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4100 \
    DATA_DIR=/var/lib/studio WEB_DIST_DIR=/opt/studio/apps/web/dist \
    MINIO_MC_CONFIG_DIR=/var/lib/studio/mc-config
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=6 \
    CMD node -e "fetch('http://127.0.0.1:4100/api/meta').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
