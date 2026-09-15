# syntax=docker/dockerfile:1

# Build every host/client artifact with the repository's supported Node and pnpm versions.
ARG NODE_IMAGE=node:24-bookworm
FROM ${NODE_IMAGE} AS builder

# Official client artifacts embed this source revision without copying .git into the image.
ARG DSH_CLIENT_COMMIT_HASH

WORKDIR /app

RUN corepack enable \
  && corepack prepare pnpm@11.7.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile
RUN test -n "$DSH_CLIENT_COMMIT_HASH" \
  || (echo "DSH_CLIENT_COMMIT_HASH build argument is required" >&2; exit 1)
RUN DSH_CLIENT_COMMIT_HASH="$DSH_CLIENT_COMMIT_HASH" pnpm run build:official


# Keep the complete workspace closure because the private JDCloud patch loads local packages at runtime.
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
  DSH_HOME=/var/lib/jdcloud-harness

WORKDIR /app

RUN corepack enable \
  && corepack prepare pnpm@11.7.0 --activate

COPY --from=builder --chown=node:node /app /app

# Runtime mounts use these writable roots and the node user's numeric ownership.
RUN mkdir -p /var/lib/jdcloud-harness /workspace \
  && chown -R node:node /var/lib/jdcloud-harness /workspace \
  && chmod +x /app/docker-entrypoint.sh

USER node
WORKDIR /workspace

EXPOSE 3080

# Register the local JDCloud bundle before launching the selected command.
ENTRYPOINT ["/app/docker-entrypoint.sh"]

# Compose supplies the public trusted host argument.
CMD ["node", "/app/apps/cli/lib/bin.js", "web", "--no-open"]
