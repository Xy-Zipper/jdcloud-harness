#!/bin/sh
set -eu

# Register the image-local JDCloud bundle so profile boot links its plugin dependencies.
node /app/apps/cli/lib/bin.js plugin --profile web add link:/app/packages/bundle/jdcloud-login

exec "$@"
