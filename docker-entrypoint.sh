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

# The rollout defaults to Ontology but retains one explicit JDCloud rollback
# selector until stage 10 removes the old implementation after production stability.
case "${HARNESS_IDENTITY_BUNDLE:-ontology}" in
  ontology)
    remove_bundle @deepseek-ai/dsh-jdcloud-login
    node /app/apps/cli/lib/bin.js plugin --profile web add link:/app/packages/bundle/ontology-login
    ;;
  jdcloud)
    remove_bundle @deepseek-ai/dsh-ontology-login
    node /app/apps/cli/lib/bin.js plugin --profile web add link:/app/packages/bundle/jdcloud-login
    ;;
  *)
    echo "HARNESS_IDENTITY_BUNDLE must be ontology or jdcloud" >&2
    exit 1
    ;;
esac

exec "$@"
