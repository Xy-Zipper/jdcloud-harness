# No `# syntax=` directive on purpose: it makes BuildKit fetch the frontend image from
# Docker Hub on every build, which fails in restricted networks. This file only uses
# features built into the bundled frontend.

# Build every host/client artifact with the repository's supported Node and pnpm versions.
ARG NODE_IMAGE=node:24-bookworm

# Registry for build-time installs and runtime package operations. Override with a mirror
# (e.g. https://registry.npmmirror.com) when the default registry is unreachable; the
# lockfile integrity hashes still verify every tarball.
ARG NPM_REGISTRY=https://registry.npmjs.org

FROM ${NODE_IMAGE} AS builder

ARG DSH_CLIENT_COMMIT_HASH
ARG DSH_CLIENT_TITLE=LSY-Agent
ARG NPM_REGISTRY

WORKDIR /app

# Ship a real pnpm binary instead of a corepack shim: corepack resolves versions through
# the registry at every invocation (the entrypoint runs `pnpm` outside any project, where
# no packageManager field applies), which made container startup require registry access.
# pnpm ignores the `npm_config_registry` environment variable, so pass --registry explicitly.
RUN npm install --global pnpm@11.7.0 --registry "$NPM_REGISTRY"

COPY . .

RUN pnpm install --frozen-lockfile --registry "$NPM_REGISTRY"
RUN test -n "$DSH_CLIENT_COMMIT_HASH" \
  || (echo "DSH_CLIENT_COMMIT_HASH build argument is required" >&2; exit 1)
RUN DSH_CLIENT_COMMIT_HASH="$DSH_CLIENT_COMMIT_HASH" DSH_CLIENT_TITLE="$DSH_CLIENT_TITLE" pnpm run build:official


# Keep the complete workspace closure because the private JDCloud patch loads local packages at runtime.
FROM ${NODE_IMAGE} AS runtime

ARG NPM_REGISTRY

ENV NODE_ENV=production \
  DSH_HOME=/var/lib/jdcloud-harness \
  npm_config_registry=${NPM_REGISTRY}

WORKDIR /app

# Real pnpm binary (see builder stage); no registry access is needed to start a container.
# The node user's npmrc keeps runtime package operations (profile plugin installs) on the
# same registry the image was built with.
RUN npm install --global pnpm@11.7.0 --registry "$NPM_REGISTRY" \
  && printf 'registry=%s\n' "$NPM_REGISTRY" > /home/node/.npmrc \
  && chown node:node /home/node/.npmrc

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
