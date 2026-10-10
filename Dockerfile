# syntax=docker/dockerfile:1

# Build every host/client artifact with the repository's supported Node and pnpm versions.
ARG NODE_IMAGE=node:24-bookworm
FROM ${NODE_IMAGE} AS builder

# Official client artifacts embed this source revision without copying .git into the image.
ARG DSH_CLIENT_COMMIT_HASH
ARG DSH_CLIENT_TITLE=Ontology Agent

# Keep pnpm version files in a path readable by both root and node.
ENV COREPACK_HOME=/opt/corepack

WORKDIR /app

RUN mkdir -p "$COREPACK_HOME" \
  && corepack enable \
  && corepack prepare pnpm@11.7.0 --activate \
  && chmod -R a+rX "$COREPACK_HOME"

COPY . .

RUN pnpm install --frozen-lockfile
RUN test -n "$DSH_CLIENT_COMMIT_HASH" \
  || (echo "DSH_CLIENT_COMMIT_HASH build argument is required" >&2; exit 1)
RUN DSH_CLIENT_COMMIT_HASH="$DSH_CLIENT_COMMIT_HASH" DSH_CLIENT_TITLE="$DSH_CLIENT_TITLE" pnpm run build:official


# Keep the complete workspace closure because the private Ontology bundle loads local packages at runtime.
FROM ${NODE_IMAGE} AS runtime

# The profile updater runs as node and reuses the prepared pnpm version.
ENV NODE_ENV=production \
  DSH_HOME=/var/lib/jdcloud-harness \
  COREPACK_HOME=/opt/corepack

WORKDIR /app

RUN mkdir -p "$COREPACK_HOME" \
  && corepack enable \
  && corepack prepare pnpm@11.7.0 --activate \
  && chmod -R a+rX "$COREPACK_HOME"

COPY --from=builder --chown=node:node /app /app

# Runtime mounts use these writable roots and the node user's numeric ownership.
RUN mkdir -p /var/lib/jdcloud-harness /workspace \
  && chown -R node:node /var/lib/jdcloud-harness /workspace \
  && chmod +x /app/docker-entrypoint.sh

USER node
WORKDIR /workspace

EXPOSE 3080

# Select the local Ontology bundle before launching the selected command.
ENTRYPOINT ["/app/docker-entrypoint.sh"]

# Compose supplies the public trusted host argument.
CMD ["node", "/app/apps/cli/lib/bin.js", "web", "--no-open"]
