# Agent Note: JDCloud browser and tenant-user isolation

Status: implemented

English | [中文](2026-09-18-jdcloud-browser-user-isolation.zh.md)

## Problem

JDCloud login credentials were stored under one process-wide key, so a second computer inherited the first browser's token and could read the same Session and Workspace projections without logging in. The deployment also disabled Harness browser authentication, leaving no request-local identity for Host authorization.

## Decision

The Connection deployment can issue an independent signed HttpOnly `dsh-user-session` cookie while keeping Harness launch-token authentication disabled. RPC and Fetch handlers carry that browser identity through AsyncLocalStorage. JDCloud login credentials are keyed by the browser id, and new ownership records use a deterministic hash of normalized service address, tenant id, and `userInfo.id`. Old unowned records are ignored.

Session list/search/history and Workspace commands and initial baselines check the current tenant-user owner. Interactive terminal operations require the current JDCloud login to be a system administrator. The browser cookie is transport identity; it does not expose the JDCloud bearer token.

## Alternatives considered

**Reuse one process-wide JDCloud login record.** Rejected because another computer could inherit the token and access the first browser's data without logging in.

**Enable Harness browser authentication instead.** Rejected because this deployment explicitly uses JDCloud login without Harness browser authentication; the independent cookie supplies only the missing request-local browser identity.

**Migrate existing unowned records.** Rejected because those records have no reliable tenant-user owner and assigning them would risk exposing historical data to the wrong account.

## Consequences

Separate browsers must log in separately. The same tenant and `userInfo.id` share newly-owned data across computers. Existing data without an owner is intentionally not migrated. Live control broadcasts and other Host surfaces still require follow-up filtering before this can be described as complete confidentiality isolation.
