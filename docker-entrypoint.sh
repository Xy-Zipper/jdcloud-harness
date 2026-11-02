#!/bin/sh
set -eu

# Keep this descriptor open through exec: only one container may own a data directory.
# The kernel releases it on process exit; the lock file itself must stay in place.
: "${DSH_HOME:?docker-entrypoint: DSH_HOME must name the persistent data directory}"
mkdir -p "$DSH_HOME"
exec 9>"$DSH_HOME/.docker-runtime.lock"
if ! flock -n 9; then
  echo "docker-entrypoint: DSH_HOME is already in use by another container: $DSH_HOME" >&2
  exit 1
fi

# A previous container's PID lock can name a reused PID in this container.
# Exclusive ownership of the data directory makes its abandoned install locks removable.
rm -f -- "$DSH_HOME/profiles/web/package.json.lock" "$DSH_HOME/profiles/web/package.json.lock.takeover-"*

# Register the image-local JDCloud bundle so profile boot links its plugin dependencies.
node /app/apps/cli/lib/bin.js plugin --profile web add link:/app/packages/bundle/jdcloud-login

exec "$@"
