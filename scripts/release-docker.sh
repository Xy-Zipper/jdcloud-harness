#!/bin/bash
# Builds the Linux deployment image in Docker Desktop and optionally publishes it.
set -euo pipefail

usage() {
    printf '%s\n' \
        'Usage: release-docker.sh --version VERSION [--proxy-port PORT]' \
        '       release-docker.sh --build-only [--proxy-port PORT]'
}

fail() {
    printf '%s\n' "$1" >&2
    exit 1
}

version=''
proxy_port=''
build_only=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            [[ ${2:-} =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail 'Enter a valid Docker tag after --version.'
            version=$2
            shift 2
            ;;
        --proxy-port)
            [[ ${2:-} =~ ^[0-9]{1,5}$ ]] && ((10#$2 >= 1 && 10#$2 <= 65535)) \
                || fail 'Enter an HTTP proxy port from 1 to 65535 after --proxy-port.'
            proxy_port=$((10#$2))
            shift 2
            ;;
        --build-only)
            build_only=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *) fail "Unknown argument: $1. Run with --help for usage." ;;
    esac
done

if [[ $build_only == true ]]; then
    [[ -z $version ]] || fail 'Use --build-only without --version.'
else
    [[ -n $version ]] || fail 'Specify --version to publish, or use --build-only.'
fi

cd -- "$(dirname -- "$0")/.."
command -v docker >/dev/null || fail 'Install and start Docker Desktop before building.'
commit_hash=$(git rev-parse --verify HEAD) || fail 'Cannot read Git HEAD. Check the repository checkout.'
local_image=jdcloud-harness:local
build_args=(--load --platform linux/amd64 --build-arg "DSH_CLIENT_COMMIT_HASH=$commit_hash" --tag "$local_image")
if [[ -n ${NODE_IMAGE:-} ]]; then
    build_args+=(--build-arg "NODE_IMAGE=$NODE_IMAGE")
fi
if [[ -n $proxy_port ]]; then
    proxy_url="http://host.docker.internal:${proxy_port}"
    build_args+=(--build-arg "HTTP_PROXY=$proxy_url" --build-arg "HTTPS_PROXY=$proxy_url"
        --build-arg "http_proxy=$proxy_url" --build-arg "https_proxy=$proxy_url")
fi
docker buildx build "${build_args[@]}" .

if [[ $build_only == true ]]; then
    printf 'Built %s\n' "$local_image"
    exit 0
fi

registry=crpi-is7b7e9g1wrfpsor.cn-guangzhou.personal.cr.aliyuncs.com
target_image="${registry}/lushanyun-docker/jdcloud-harness:${version}"
docker login '--username=萧影科技' "$registry"
docker tag "$local_image" "$target_image"
docker push "$target_image"
printf 'Published: %s\n' "$target_image"
