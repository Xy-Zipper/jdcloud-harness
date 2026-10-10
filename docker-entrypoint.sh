#!/bin/sh
set -eu

profile_manifest="${DSH_HOME:-/var/lib/jdcloud-harness}/profiles/web/package.json"

# Report whether a bundle dependency is present in the persisted Web profile.
bundle_installed() {
  [ -f "$profile_manifest" ] && node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  process.exit(dependencies[process.argv[2]] === undefined ? 1 : 0);
' "$profile_manifest" "$1"
}

# Remove one persisted bundle only when pnpm can actually find the dependency.
remove_bundle() {
  if bundle_installed "$1"
  then
    node /app/apps/cli/lib/bin.js plugin --profile web remove "$1"
  fi
}

# Remove the retired dependency from persisted profiles before selecting the
# only supported application identity layer.
remove_bundle @deepseek-ai/dsh-jdcloud-login
node /app/apps/cli/lib/bin.js plugin --profile web add link:/app/packages/bundle/ontology-login

exec "$@"
