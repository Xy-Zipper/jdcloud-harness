# Agent Note: Tenant-Scoped Workspace Registrations

Status: implemented

English | [中文](2026-09-18-tenant-scoped-workspace-paths.zh.md)

## Problem

Workspace records are isolated by tenant and user, but the registry previously enforced one record for each canonical filesystem path. After switching tenants, selecting a directory already registered by the previous tenant resolved that hidden record and returned `workspace/not-found` instead of creating a private registration.

## Decision

The registry stores canonical paths but permits duplicate-path records when an owner-scoped caller explicitly requests them. The Workspace controller resolves all records for the selected path, reuses only a record owned by the current tenant-user scope, and otherwise creates a new record. Unauthenticated or non-owner callers keep the existing idempotent single-path behavior.

When multiple records share a path, startup does not assign unaccounted historical sessions to one of them because the registry has no tenant credential context. Sessions created through the authenticated session flow remain attached to the selected Workspace record.

## Alternatives considered

**Reuse the previous tenant's record.** Rejected because it exposes that tenant's session account and conversation history.

**Return a path-occupied error.** Rejected because a tenant-user should be able to work in the same server directory without sharing Workspace data.

**Store owner identity inside the Workspace domain record.** Rejected for this fix because owner credentials already define the durable scope and adding a persisted schema migration is unnecessary for creating isolated records.

## Consequences

Different tenant-user scopes can register the same physical directory and receive independent Workspace and Session projections. Historical sessions whose owner cannot be inferred from a duplicate path remain ungrouped after bootstrap rather than being assigned to the wrong scope. The registry's `resolveByPath` remains backward-compatible for callers that do not need owner disambiguation; `resolveAllByPath` serves the tenant-aware controller.
