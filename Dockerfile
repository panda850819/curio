# syntax=docker/dockerfile:1
FROM oven/bun:1.3.5-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.5-alpine AS runtime
WORKDIR /app
ARG CURIO_RELEASE_REVISION=unknown
ARG CURIO_BUILD_TIME=unknown
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/curio.db \
    CURIO_RELEASE_REVISION=$CURIO_RELEASE_REVISION \
    CURIO_BUILD_TIME=$CURIO_BUILD_TIME
LABEL org.opencontainers.image.title="Curio" \
      org.opencontainers.image.revision=$CURIO_RELEASE_REVISION \
      org.opencontainers.image.created=$CURIO_BUILD_TIME \
      com.panda.personal-infra.service="curio" \
      com.panda.personal-infra.healthz="http://curio:3000/healthz" \
      com.panda.personal-infra.readyz="http://curio:3000/readyz" \
      com.panda.personal-infra.version="http://curio:3000/version" \
      com.panda.personal-infra.revision=$CURIO_RELEASE_REVISION

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations

RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3000/healthz');if(!r.ok)process.exit(1)"]

CMD ["bun", "run", "src/index.ts"]
