# Agent Note: JDCloud ordinary-user browser controls

Status: implemented

English | [中文](2026-09-17-jdcloud-ordinary-user-browser-controls.zh.md)

## Problem

JDCloud authentication exposed `systemAdministrator` to the Web client, but ordinary users could still open interactive terminals and select Session permission presets. The terminal UI could delete container files, while `danger-full-access` could remove the sandbox from Agent commands. Hiding one terminal button was insufficient because guide entries, retained-terminal recovery, existing tab rendering, and direct sidebar navigation were independent browser paths.

## Decision

The JDCloud login UI applies one reversible ordinary-user policy from the current authenticated tenant. It shadows the permission picker with the existing administrator-only controls, rejects `/permission` together with `/model`, and filters the `terminal` page kind from the right-sidebar registry. Tenant switches update the same policy without remounting the application.

The right-sidebar registry owns a general `registerAvailabilityFilter()` operation. A filtered kind is absent from guide entries, registry lookup, rendering dispatch, and direct browser navigation while the underlying type registration remains mounted. Terminal recovery also checks the current registry result before querying or reopening retained processes.

The browser policy registers an ordered new-Session initializer after ordinary-user authentication. It runs `/permission workspace-write` before a reused or newly created blank Session is opened; command failure or an unavailable command prevents navigation. Administrators do not install the initializer. The policy does not rewrite an existing Session's durable permission selection, authorize Host endpoints, or confine Agent tools. It is a browser workflow restriction, not security isolation; deployments that need confidentiality or tamper resistance require authenticated Host authorization and process/filesystem isolation.

## Alternatives considered

**Remove the terminal plugin from the JDCloud bundle.** Rejected because administrators still need the terminal, and tenant changes must update access without restarting the Client graph.

**Shadow only the terminal guide card.** Rejected because retained-terminal recovery, existing layout records, and programmatic `openTab('terminal')` would remain usable.

**Treat JDCloud Login as Host authorization.** Rejected for this change because the Docker composition disables Harness browser authentication and the stored JDCloud login is Host-global. A secure per-user policy requires a separate transport identity and authorization design rather than a browser filter.

## Consequences

Ordinary users cannot select permissions or open, render, or recover terminal tabs through the supported Web UI. Administrators retain those controls, and switching tenants updates them immediately. Focused Client tests cover registration filtering, ordinary/admin transitions, teardown, and terminal recovery. Direct Host calls and Agent access remain outside this policy and are documented as a deployment limitation.
