# Agent Note: Request-scoped sandbox escalation schemas

Status: implemented

English | [中文](2026-09-08-request-scoped-sandbox-escalation-schemas.zh.md)

## Problem

Sandboxing shell and filesystem tools advertised the composition-wide `sandbox_permissions` targets on every model request. A session already running in `danger-full-access`, a session with approval policy `never`, or a composition without an approval service therefore showed arguments that could never succeed. Models sometimes supplied one of those arguments to an ordinary write, so strict execution validation rejected the call before the command or file mutation ran. Repeating the call with another non-widening target could prevent the requested file from ever being created.

The strict-widening execution check is a security rule and must remain fail closed. The defect was the mismatch between request-time capabilities and the static schema shown to the model, not the rejection itself.

## Decision

`ToolDefinition.modelSchema()` may project a request-specific description and parameter schema during system-prompt assembly. The complete registered schema remains the execution validator, and agent-less catalog inspection retains that static schema. Native tool schemas and generated PTC SDK declarations use the same request projection.

Sandboxing Bash, PowerShell, `write`, and `edit` project escalation arguments from the current agent's session. `read-only` exposes `workspace-write` and `danger-full-access`, while `workspace-write` exposes only `danger-full-access`. The fields are absent under `danger-full-access`, approval policy `never`, a missing approval service, or a non-confining backend. `ApprovalService.policyOf()` supplies the effective session policy used by both request projection and approval enforcement.

Execution still accepts the complete static argument vocabulary so persisted calls and explicitly injected arguments reach the existing validation path. `approveEscalation()` independently rejects a target that is not strictly wider, and blank or unpaired justifications remain invalid. Denial results include the escalation hint only when the same request has a usable wider mode; PowerShell keeps its confinement-specific language and named-pipe guidance even when escalation is unavailable.

## Alternatives considered

- **Treat same-mode requests as ordinary calls** — this would weaken the strict-widening security rule and hide malformed model output instead of correcting the advertised capability.
- **Rely only on runtime-context prose** — the incident already included an explicit instruction not to set `sandbox_permissions`; the contradictory schema remained a stronger affordance and repeated the failure.
- **Remove escalation fields from every schema** — this would prevent valid one-shot approval from `read-only` and `workspace-write` sessions.
- **Register separate tools per permission preset** — permission state changes per session and can change between requests, so static registrations would duplicate tool implementations and drift from execution policy.

## Consequences

Model requests contain only escalation choices that can pass the session's current mode and approval gate. Ordinary operations in `danger-full-access` no longer fail because the model was invited to request the mode it already had, and unattended sessions no longer receive unusable approval arguments or hints. The execution boundary remains fail closed for manually injected, stale, or non-widening calls.

Request-specific schemas can change the model prompt cache prefix when sandbox mode or approval policy changes; those changes already alter the request's runtime policy and therefore must be visible. Static generated catalogs continue to document the complete execution vocabulary, while request snapshots verify the effective subset.
