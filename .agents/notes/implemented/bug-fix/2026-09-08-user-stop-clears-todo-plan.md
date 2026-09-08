# Agent Note: User stop clears the todo plan

Status: implemented

English | [中文](2026-09-08-user-stop-clears-todo-plan.zh.md)

## Problem

An active `todo_write` plan remained visible after the user clicked Web Stop. The agent loop correctly recorded `turn/end { kind: 'aborted', reason: { kind: 'user' } }`, but the `todos` projection retained the latest list until another `turn/start`, so `in_progress` tasks appeared to keep running after the turn had stopped. Ordinary completed turns still need to retain their checklist while the user reads the answer, as decided by the [turn-scoped plan lifetime](../feature/2026-07-28-todo-plan-clears-on-next-turn.md).

## Decision

The `todos` projection returns `null` when a `turn/end` records an `aborted` reason with the `user` cause. It also keeps the existing `turn/start` clearance; completed, parent-cancelled, hook-cancelled, disposed, error, blocked, maximum-token, crash-repaired `interrupted`, and extension-defined turn endings retain the latest list. The durable `todo/write` event remains unchanged because this rule controls the current UI projection, not the recorded model action.

The projection uses `stateVersion` 3 so persisted version-2 rows refold under the new rule. The standalone client fixture mirrors the same fold. The Web live-interactions scenario shows the panel before Stop and asserts that it disappears after the user-aborted turn settles.

## Alternatives considered

- **Clear on every `turn/end`** — this would also hide a completed checklist while the user reads the answer.
- **Append an empty `todo/write`** — this would fabricate a model-authored update and alter durable state for a presentation lifetime rule.
- **Add a `cancelled` todo status** — hiding the panel needs no new item state, event payload, tool schema, or UI treatment.
- **Clear on `interrupted`** — that reason describes crash repair, not the Stop button, so it would leave the reported bug unchanged.

## Consequences

Clicking Stop hides the current task panel as soon as the user-aborted `turn/end` reaches the projection, and reopening that session does not restore the stopped plan. Other cancellation causes retain the plan until the next turn starts because they are not direct user Stop actions. The session log still preserves the submitted task list for audit and replay; the event remains excluded from model history.
