#requires -Version 5.1

<#
.SYNOPSIS
Builds and pushes a versioned JDCloud Harness image to the Aliyun registry.
.DESCRIPTION
Requires Git, a running Docker daemon, and the local proxy on port 35347.
Removes the local image tag when present, builds local, then logs in interactively.
Stops on command failure; completed image operations are not rolled back.
Sets DSH_CLIENT_COMMIT_HASH, http_proxy and https_proxy, and removes DOCKER_BUILDKIT
in the current process. Builds the working tree, including uncommitted files.
.PARAMETER Version
Docker tag to publish. Omit it to receive an interactive parameter prompt.
.EXAMPLE
.\scripts\release-docker.ps1 -Version 1.0.0
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
# Check native exit codes explicitly on both Windows PowerShell and PowerShell 7.
$PSNativeCommandUseErrorActionPreference = $false
$registry = 'crpi-is7b7e9g1wrfpsor.cn-guangzhou.personal.cr.aliyuncs.com'
$targetImage = "${registry}/lushanyun-docker/jdcloud-harness:${Version}"

Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
    Get-Command git, docker -CommandType Application -ErrorAction Stop | Out-Null

    # Query first so an absent local tag is harmless while daemon failures stop the release.
    $oldImage = docker image ls --quiet --filter 'reference=jdcloud-harness:local'
    if ($LASTEXITCODE -ne 0) {
        throw 'Cannot list Docker images. Check that Docker is running and retry.'
    }
    if ($oldImage) {
        docker image rm jdcloud-harness:local
        if ($LASTEXITCODE -ne 0) {
            throw 'Cannot remove jdcloud-harness:local. Resolve the Docker error and retry.'
        }
    }

    # Embed HEAD in the client; Docker still builds files from the current working tree.
    $commitHash = git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) {
        throw 'Cannot read Git HEAD. Check the repository checkout and retry.'
    }
    $Env:DSH_CLIENT_COMMIT_HASH = $commitHash.Trim()
    Remove-Item Env:DOCKER_BUILDKIT -ErrorAction SilentlyContinue
    $Env:http_proxy = 'http://127.0.0.1:35347'
    $Env:https_proxy = 'http://127.0.0.1:35347'

    docker build --build-arg "DSH_CLIENT_COMMIT_HASH=$Env:DSH_CLIENT_COMMIT_HASH" --tag jdcloud-harness:local .
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker build failed. Resolve the build error before retrying the release.'
    }

    # Docker owns the password prompt and credential storage; no password is passed by this script.
    docker login '--username=萧影科技' $registry
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker login failed. Check the registry credentials before retrying.'
    }

    # Use the freshly built tag directly instead of requiring a manually copied image ID.
    docker tag jdcloud-harness:local $targetImage
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker tag failed. Check jdcloud-harness:local before retrying.'
    }
    docker push $targetImage
    if ($LASTEXITCODE -ne 0) {
        throw "Docker push failed for ${targetImage}. Check the registry state and Docker error before retrying."
    }

    Write-Host "Published: $targetImage"
}
finally {
    Pop-Location
}
