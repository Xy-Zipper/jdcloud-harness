# Agent Note: JDCloud token-transfer login

Status: implemented

English | [中文](2026-09-09-jdcloud-token-transfer-login.zh.md)

## Problem

JDCloud users can enter Harness from another company page that already owns a JDCloud Token. The Web application serves only explicit index paths, its browser authentication reserves the `token` query name, and browser code must not persist or directly use the JDCloud credential. Its authority-bound browser cookie is also `SameSite=Strict`, so a cross-site redirect chain cannot carry an existing cookie to the application index. A transfer link therefore cannot be implemented as a client-only route or forwarded unchanged to the application root.

## Decision

The existing JDCloud login UI plugin owns the exact `/login/transfer` Host route and its Client root contribution. The Host route returns a no-store document with a nonce-restricted inline script that renames the incoming `token` parameter and starts a same-site navigation to the authenticated Web root. The internal values travel in the URL fragment, which carries them to Client code without sending the JDCloud Token in the root request or subresource referrers. The second navigation carries an existing Strict cookie without changing Connection authentication. The Client reads the internal parameters once and immediately replaces the visible URL with `/login/transfer` before validation. The transfer root has priority `-110`, above the account/password login root, and either reveals the application after success or offers an explicit return to account/password login after failure.

The authentication controller owns transferred-token validation and storage. `loginWithToken()` deletes the previous login, accepts any normalized absolute HTTP(S) service address, calls `GET /api/oauth/currentUser` and `GET /api/system/corp/getCorpList`, requires both responses to name the same current tenant, and commits the Token only after all checks pass. `defaultBaseUrl` remains the initial account/password login value and does not restrict transfers.

## Alternatives considered

**Make the static frontend serve every unknown path as the SPA index.** Rejected because one optional login integration would weaken the explicit 404 behavior of the shared static server and enlarge the routing change beyond this feature.

**Validate and store the Token in browser local storage.** Rejected because the existing controller deliberately owns JDCloud credentials on the Host and exposes only redacted authentication state to browser plugins.

**Forward `/login/transfer?token=...` directly to `/`.** Rejected because Connection reserves the root `token` query parameter for the Harness launch credential, so the JDCloud Token would be interpreted as an invalid browser-authentication token.

**Use an HTTP redirect after renaming the Token.** Rejected because a window opened by another site remains a cross-site redirect chain, so the browser withholds the `SameSite=Strict` Harness cookie from the redirected index request.

**Mint a Harness browser cookie from a JDCloud Token.** Rejected because JDCloud login does not grant access to the local Harness process; Connection remains the independent browser-authentication owner.

**Restrict transfers to configured service addresses.** Rejected because the integration accepts tenant environments selected by each source link without Host configuration updates.

## Consequences

The transfer entry requires an existing Harness browser-authentication cookie, like every served Web index. A browser exchanges the launch URL printed by `dsh web` once before cross-site transfer links can use that cookie. Invalid transfer links intentionally remove a previous JDCloud login before showing recovery, matching the source-page flow. Because the source link controls the service address, it can send its supplied Token to an arbitrary HTTP(S) server and direct the Host to private-network addresses; deployments trust the link producer to select the intended JDCloud service.
