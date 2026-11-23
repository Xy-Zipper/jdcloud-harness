#requires -Version 5.1

<#
.SYNOPSIS
Builds and pushes a versioned JDCloud Harness image to the Aliyun registry.
.DESCRIPTION
Requires Git and Docker Desktop with Buildx. Builds the current working tree for
linux/amd64 and embeds Git HEAD in the client. NODE_IMAGE can override the base
image. Stops on command failure.
.PARAMETER Version
Docker tag to publish. Without BuildOnly, omitting Version prompts for a tag.
.PARAMETER ProxyPort
HTTP proxy port on the Docker Desktop host for dependency downloads during the build.
.PARAMETER BuildOnly
Builds jdcloud-harness:local without logging in or publishing.
.EXAMPLE
.\scripts\release-docker.ps1 -Version 1.0.0 -ProxyPort 7890
#>
[CmdletBinding(DefaultParameterSetName = 'Publish')]
param(
    [Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Publish')]
    [ValidatePattern('\A[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\z')]
    [string]$Version,

    [ValidatePattern('\A[0-9]{1,5}\z')]
    [string]$ProxyPort,

    [Parameter(Mandatory = $true, ParameterSetName = 'BuildOnly')]
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
# Check native exit codes explicitly on both Windows PowerShell and PowerShell 7.
$PSNativeCommandUseErrorActionPreference = $false
if ($PSCmdlet.ParameterSetName -eq 'BuildOnly' -and -not $BuildOnly) {
    throw 'Use -Version to publish or specify -BuildOnly.'
}
$localImage = 'jdcloud-harness:local'
$buildArgs = @('--load', '--platform', 'linux/amd64', '--tag', $localImage)
if ($env:NODE_IMAGE) {
    $buildArgs += @('--build-arg', "NODE_IMAGE=$env:NODE_IMAGE")
}
if ($PSBoundParameters.ContainsKey('ProxyPort')) {
    $port = [int]$ProxyPort
    if ($port -lt 1 -or $port -gt 65535) {
        throw 'Enter an HTTP proxy port from 1 to 65535.'
    }
    $proxyUrl = "http://host.docker.internal:${port}"
    $buildArgs += @(
        '--build-arg', "HTTP_PROXY=$proxyUrl", '--build-arg', "HTTPS_PROXY=$proxyUrl",
        '--build-arg', "http_proxy=$proxyUrl", '--build-arg', "https_proxy=$proxyUrl"
    )
}

Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
    Get-Command git, docker -CommandType Application -ErrorAction Stop | Out-Null

    $commitHash = git rev-parse --verify HEAD
    if ($LASTEXITCODE -ne 0) {
        throw 'Cannot read Git HEAD. Check the repository checkout and retry.'
    }
    docker buildx build @buildArgs --build-arg "DSH_CLIENT_COMMIT_HASH=$($commitHash.Trim())" .
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker build failed. Resolve the build error before retrying the release.'
    }

    if ($BuildOnly) {
        Write-Host "Built $localImage"
        return
    }

    $registry = 'crpi-is7b7e9g1wrfpsor.cn-guangzhou.personal.cr.aliyuncs.com'
    $targetImage = "${registry}/lushanyun-docker/jdcloud-harness:${Version}"
    docker login '--username=萧影科技' $registry
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker login failed. Check the registry credentials before retrying.'
    }

    docker tag $localImage $targetImage
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
