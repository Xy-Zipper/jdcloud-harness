# Agent Note: JDCloud browser prompt admission

Status: implemented

English | [中文](2026-09-07-jdcloud-browser-prompt-admission.zh.md)

## Problem

The low-code Web deployment needs JDCloud password login and must validate its Token immediately before every submitted conversation request. The existing `agent/pre-step` waterfall runs after the Agent inbox claims input. Rejecting there records an attempted turn and consumes the submitted message, which conflicts with a login gate that must leave the Session and browser draft untouched when authentication expires. The same deployment reserves settings, model selection, and Agent preset selection for current-tenant system administrators; hiding buttons alone would still leave typed commands and Remote model selection callable.

## Decision

Session Controller exposes `api-session/prompt-admission` at the browser `prompt()` entry before attachment persistence and Agent delivery. Admission listeners receive the Session id and caller cancellation signal, call `next()` after accepting, and reject before any Session or inbox mutation. This event governs browser prompt submission only; Agent-internal follow-ups and other ingress paths keep their existing policies.

Session Controller also exposes `api-session/model-selection-admission` after it resolves the addressed ordinary Agent but before model validation, Session mutation, or default-model persistence. A listener that rejects preserves both the Session selection and `agentDefaultModel`; an accepting listener calls `next()`.

`dsh-api-jdcloud-auth-controller` reimplements `POST /api/oauth/login`, `GET /api/system/corp/getCorpList`, `GET /api/oauth/currentUser`, and `GET /api/system/corp/switchCorp/{corpId}` according to the existing JDCloud package semantics. Login sends no tenant id, validates the returned Token with the tenant and current-user calls, and stores `{ baseUrl, token, username, corpId, corpName, corps, systemAdministrator }` as a version-4 Host credential record. A version-3 record is upgraded by reading `currentUser` once. The Remote status exposes the same record without the Token. Tenant switching and every browser prompt admission refresh both tenant state and `userPermission.systemAdministrator`; codes `600`, `601`, and `602` delete the record, while other business and transport failures preserve the login and reject only the current operation. Its model-selection admission listener rejects a non-administrator before Session Controller changes model state.

`dsh-client-ui-commands` accepts reversible availability filters that apply to Host and Client command candidates, leading-input claims, stale picks, and typed Enter invocation. `dsh-client-ui-jdcloud-login` installs a filter for `/model` and priority `-100` shadows over `sidebar.settings`, `conversation.input.model`, and `conversation.hero.agentPreset` while the current tenant is not a system administrator. Tenant changes update these controls from the returned authentication status. New ordinary-user Sessions omit client-selected model and preset values and therefore use the Host default; existing durable Session selections remain unchanged.

The login Client still mounts the generated Remote contribution and shadows the built-in `root` slot at priority `-100` while the Host reports no login. Removing the shadow reveals the existing application tree, preserving Session and draft state. While authenticated, the plugin fills `sidebar.account`; its menu lists all tenants, marks the current one, switches without restoring the login page, and deletes the Host record to log out. The forwarded `credentials/record-updated` event reapplies login and administrator controls after logout, expiration, validation refresh, or tenant change. Reauthentication never automatically resubmits the retained draft.

The optional `dsh-jdcloud-login` bundle inserts the Host and Client rows and maps `JDCLOUD_DEFAULT_BASE_URL` to the controller's initial address. The default Web bundle remains independent of JDCloud.

## Alternatives considered

**Copy the complete `@jdcloud/api` package.** Rejected because its global request state, broad endpoint inventory, and front-end environment assumptions do not match Host-owned credentials or the Harness Remote lifecycle. Reimplementing the three required calls keeps the owned surface auditable.

**Validate at `agent/pre-step`.** Rejected because the inbox has already claimed the message. A failed validation would consume user input and create Agent lifecycle evidence for a request that should not enter the Session.

**Add a client router and navigate to `/login`.** Rejected because the Web Client composes through Slots and has no routing requirement here. Root shadowing preserves the mounted application and needs no second navigation state machine.

**Store the Token in browser storage.** Rejected because it would expose the secret to browser persistence and duplicate authority across Host and Client. The Client needs only redacted authentication state.

**Hide administrator controls only in React components.** Rejected because `/model` and `session.selectModel` would remain alternate model-selection paths. Slot shadows, command filtering, and Host admission enforce the same decision at each operation that can change it.

**Force existing Sessions back to the Host default.** Rejected because durable request headers are historical model choices. The administrator policy governs new selection operations and new ordinary-user Sessions without rewriting prior conversation behavior.

## Consequences

- Browser prompt policy can now reject before attachments, Session events, queue entries, or Agent inbox delivery.
- JDCloud Token storage and validation remain Host-side; the browser sends a password only during an explicit login call.
- The browser receives the account, current tenant, and complete available-tenant list needed for the sidebar, but never receives the Token.
- The browser also receives the current tenant's administrator boolean; ordinary users cannot open settings, select a model or Agent preset, or invoke `/model`.
- Direct model-selection Remote calls are rejected for ordinary users before model validation or persistence.
- New ordinary-user Sessions use the live Host default, while existing Sessions retain durable model selections.
- A successful tenant switch updates the server-side Token context and sidebar state without showing the login page.
- A Token expiration restores the login page while retaining the current application state, but the user must explicitly submit the draft again.
- `api-session/prompt-admission` is intentionally narrower than a universal ingress policy; future non-browser ingress chooses its own admission point.
