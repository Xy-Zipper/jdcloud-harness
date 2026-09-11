# Agent Note: JDCloud writable low-code function picker

Status: implemented

English | [中文](2026-09-10-jdcloud-writable-function-picker.zh.md)

## Problem

Users starting a JDCloud data-mutation conversation need to identify the intended form or workflow without copying an opaque menu id. Showing every current-user menu would expose unrelated folders and boards, while trusting a browser-provided label or permission would let stale tenant state influence model input. Multiple selected functions would also make one conversation's mutation target ambiguous.

## Decision

The `@deepseek-ai/dsh-client-ui-jdcloud-lowcode-actions` plugin adds a single-selection panel above the composer for a blank top-level Session.

- The authentication controller owns `/api/oauth/currentUser` parsing and exposes `writableMenus()` as a redacted Remote projection. It returns only type `3` forms and type `4` workflows with at least one recognized `addData`, `editData`, or `deleteData` grant.
- A card click inserts one atomic reference tag at the beginning of the current draft. Optimistic local state hides the panel in the click frame; the editor occurrence keeps it hidden after insertion. Removing the tag restores the panel.
- The tag stores only the tenant id, menu id, and label needed for display. Its submission codec reloads `writableMenus()`, requires the same current tenant and menu, and serializes only the Host-confirmed name, path, type, and permissions into the logged user message.
- The panel is absent for an active Session, a subagent Session, an unavailable current-user response, or an empty writable-menu result. Login recovery stays with the authentication UI.
- The JDCloud login bundle installs the picker beside the authentication controller, login UI, and low-code tools.

## Alternatives considered

- **Let users type menu names in ordinary text.** Names are not stable identities, can be duplicated, and provide no deterministic menu id for the model-facing tools.
- **Use a multi-select panel.** One mutation conversation needs one form or workflow target; several tags make required-field discovery and permission intent ambiguous.
- **Trust the menu captured at click time.** Tenant switches and permission changes can occur before submission, so the Host refreshes the selection when the reference is serialized.
- **Show every type `3` and type `4` menu.** Query-only menus do not satisfy the requested add, edit, or delete entry point and would imply mutation ability the current user does not have.

## Consequences

- A new Session performs a current-user request to populate the panel, and a selected reference performs another request during submission. The existing prompt-admission and low-code capability paths retain their own authorization checks.
- Users choose a readable function once, see an `@` tag in the composer, and can reverse the choice by deleting that tag.
- Browser state never authorizes an operation. A stale tenant or removed permission makes serialization fail before the user message reaches the model, and the low-code Host tools still enforce operation-specific grants.
- Query-only menus remain available through ordinary natural-language discovery and the low-code capability snapshot, but they do not appear as mutation shortcuts.
