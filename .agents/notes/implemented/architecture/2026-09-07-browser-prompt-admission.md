# Agent Note: Browser prompt admission before Session mutation

Status: implemented

English | [中文](2026-09-07-browser-prompt-admission.zh.md)

## Problem

An application login can expire immediately before a browser submits a prompt. The existing `agent/pre-step` waterfall runs after the Agent inbox claims input, so rejecting there records an attempted turn and consumes the submitted message. A browser authentication policy needs an earlier operation that leaves attachments, the Session log, the Agent inbox, and the retained draft unchanged when login validation fails.

## Decision

Session Controller exposes `api-session/prompt-admission` at the browser `prompt()` entry before attachment persistence and Agent delivery. Admission listeners receive the Session id and caller cancellation signal, call `next()` after accepting, and reject before any Session or inbox mutation. The event governs browser prompt submission only; Agent-internal follow-ups and other ingress paths retain their own admission policies.

The Ontology authentication controller registers an admission listener that validates or refreshes the current browser's Runtime Session. It reports a classified authentication error when the login is missing or expired. The controller stores tokens only in Host credentials keyed by the opaque browser-session id, while the Client receives redacted account state.

The Ontology Web layer disables shared Harness launch authentication and enables signed browser sessions. Each browser therefore selects its own credential record even when several browsers connect to one server process. Credential update events refresh the login presentation and restart Session and Workspace streams without exposing the stored payload.

## Alternatives considered

**Validate at `agent/pre-step`.** Rejected because the inbox has already claimed the message. A failed validation would consume user input and create Agent lifecycle evidence for a request that must not enter the Session.

**Treat the login page as sufficient enforcement.** Rejected because browser code is presentation, while Remote prompt calls remain callable. The Host operation that accepts a prompt must enforce authentication.

**Store one process-global current user.** Rejected because one server serves multiple browsers. A process-global identity would make every connected browser act as whichever user authenticated most recently.

**Store Runtime tokens in browser storage.** Rejected because browser persistence would expose secrets and duplicate authority between Host and Client. The Client needs only redacted identity and authentication status.

## Consequences

- Browser prompt policy can reject before attachments, Session events, queue entries, or Agent inbox delivery.
- Runtime tokens remain Host-only and browser-specific; several users can share one server process without sharing identity.
- An expired login restores the login presentation while retaining application state, but the user must explicitly resubmit the draft after authentication.
- `api-session/prompt-admission` is intentionally narrower than a universal ingress policy; every non-browser ingress selects its own admission point.
