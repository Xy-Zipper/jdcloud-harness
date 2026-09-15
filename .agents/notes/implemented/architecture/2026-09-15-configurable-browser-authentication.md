# Agent Note: Configurable browser authentication

Status: implemented

English | [中文](2026-09-15-configurable-browser-authentication.zh.md)

## Problem

Some deployments place the Web profile behind an existing identity gateway or accept the risk of relying on an application login. The mandatory Harness launch-token exchange then adds a second login step and prevents direct access to the root URL. Removing authentication globally would weaken every local and default deployment, while treating a profile-specific login as Host transport authentication would couple Connection to one application bundle and still leave pre-login Host endpoints uncovered.

## Decision

`dsh-client-connection` exposes `browserAuthentication`, which defaults to `true`. The default retains the launch-token exchange, signed authority-bound cookie, and uniform 401 response for the complete Host API.

An explicit `browserAuthentication: false` disables only the Harness browser-session check. `authenticatedUrl()` returns the clean application URL, `authorizeIndex()` permits the index request, and trusted API and WebSocket requests do not require a cookie. Host/Origin and Fetch-Metadata checks remain active and reject untrusted or cross-site requests with 403.

The JDCloud Docker composition applies the opt-out through `docker.no-browser-auth.patch.yml`. Its public port therefore relies on deployment-owned network controls and JDCloud Login for the intended user workflow; JDCloud Login is not treated as proof that every Host endpoint has an authenticated user.

## Verification

Connection unit coverage proves that the opt-out returns a clean URL, permits trusted requests without a cookie, and retains the 403 trust fence. The real CLI test boots `dsh web` with the deployment overlay, serves the index without a token, calls a Host API without a cookie, and rejects an untrusted Host. Existing authentication tests continue to pin the default token and persistent-cookie behavior.

## Alternatives considered

**Disable browser authentication globally.** This would expose existing local and default Web profiles without an explicit deployment decision. A default-on configuration preserves their current protection.

**Use JDCloud Login as the Connection authenticator.** Connection is shared by profiles that do not install JDCloud Login, and several Host endpoints exist before that application login completes. Keeping the layers independent avoids an incomplete transport identity rule.

**Have the reverse proxy perform the token exchange automatically.** The proxy would need to discover and retain a process credential and would recreate a hidden authentication mechanism. The explicit configuration states the deployment's actual policy directly.

## Consequences

An opted-out deployment has no Harness user identity at the Host transport. Any client that passes the Host/Origin checks can call the complete API, open WebSocket streams, access Sessions and files, and invoke tool-capable operations even before JDCloud Login completes. The deployment must restrict reachability through its firewall, private network, or an upstream authenticated gateway.

Default deployments retain browser authentication without configuration changes. The trust fence remains mandatory in both modes and is not an identity substitute.
