# Agent Note: Server-managed models for remote Web deployments

Status: implemented

English | [中文](2026-09-15-server-managed-models-for-remote-web.zh.md)

## Problem

The Models page depended on the Host settings mirror, but that mirror deliberately stays unavailable in a non-loopback browser. Remote deployments therefore showed `settings are unavailable in this browser` instead of the active provider directory. The first-run DeepSeek dialog also asked a browser user to manage a server credential, while the JDCloud Docker deployment supplied `GPT_API_KEY` and the shipped `deepseek-official` route resolved `DEEPSEEK_API_KEY`.

## Decision

Remote Web deployments use server-managed model configuration. `ui-settings-models` does not register a first-run DeepSeek credential dialog. When the settings mirror is unavailable, the Models store publishes the Host's active provider routes as read-only rows and omits settings, credential state, and every mutation control.

The JDCloud Compose file injects the deployment's required `GPT_API_KEY` under both `GPT_API_KEY` and `DEEPSEEK_API_KEY`. The shipped DeepSeek chat route and DeepSeek web-search route can therefore resolve the same server-side secret without a browser write or an image-baked credential. Administrators edit `$DSH_HOME/settings.yaml` only when the deployment needs a custom endpoint, model id, or catalog.

The loopback Models editor retains its existing settings and credential behavior. Removing the first-run dialog does not make a model credential optional; it moves ownership of that credential to the server deployment.

## Alternatives considered

**Enable Host settings for every remote browser.** Rejected because the loopback restriction protects settings and credential-management operations from network clients. JDCloud Login authenticates application users but does not establish per-user authorization for every Host settings mutation.

**Hide the Models section in remote browsers.** Rejected because the active provider directory is useful for diagnosing the server configuration and can be exposed without sending settings values or credential state.

**Rename the adapter's default credential reference to `GPT_API_KEY`.** Rejected because `DEEPSEEK_API_KEY` is the repository-wide DeepSeek default used by other profiles and packages. The deployment alias is narrower and preserves existing compositions.

## Consequences

Remote users can open Models and see which provider routes are active without receiving server settings or credential metadata. They cannot edit model configuration from the browser and are not blocked by a first-run API-key dialog. A JDCloud Docker deployment needs one `GPT_API_KEY` value for the default DeepSeek route; custom endpoints and model catalogs remain explicit server configuration.
