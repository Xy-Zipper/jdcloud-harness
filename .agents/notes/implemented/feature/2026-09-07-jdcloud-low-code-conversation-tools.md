# Agent Note: JDCloud low-code conversation tools with Host authorization

Status: implemented

English | [中文](2026-09-07-jdcloud-low-code-conversation-tools.zh.md)

## Problem

JDCloud browser prompt admission verifies the stored login, but that check alone does not tell the model which forms and workflows the current tenant exposes. A generic low-code tool could accept guessed menu ids or model-supplied permissions, which would let an alternate caller attempt operations that `/api/oauth/currentUser` does not authorize. The service address and Token must remain Host-owned, and table creation needs the stronger `systemAdministrator` grant even though its upstream operation spans several requests.

## Decision

The `@deepseek-ai/dsh-tool-jdcloud-lowcode` plugin derives one authorization snapshot for each admitted browser user prompt and uses that snapshot for the complete Turn:

- The authentication controller checks `/api/system/corp/getCorpList` before Session delivery. The low-code plugin then calls `/api/oauth/currentUser` through the controller's authenticated Host request method, so the service address and Token do not enter browser state, tool arguments, or model context.
- The plugin recursively filters `menuList` to type `3` forms and type `4` workflows. Its durable model message contains only the current tenant identity, `systemAdministrator`, menu ids, names, paths, types, and `agentPermissions`; it omits the remaining current-user response.
- Tool execution requires the snapshot for the current open Turn, requires the Host-local current tenant id to match it, and requires every requested menu id to appear in it. A tenant mismatch returns `JDCLOUD_LOWCODE_TENANT_CHANGED` before any JDCloud network request. Read operations need menu visibility only. `jdcloud_lowcode_create`, `jdcloud_lowcode_update`, and `jdcloud_lowcode_delete` respectively require `addData`, `editData`, and `deleteData`; a missing or empty `agentPermissions` list grants no write operation. After the create grant passes, the executor reloads the live field definition and rejects missing required top-level or child-row values before the modifying request.
- The system prompt directs the model to derive every field value supported by user-provided facts, including amounts, dates, purposes, descriptions, and nested details, rather than limiting inference to titles or free text. It asks naturally for genuinely missing information and shows every described field in one confirmation table before creation. The table includes required and optional fields, applicant and department fields, nested fields, and empty attachment fields; the model cannot invent opaque ids, selection values, or attachment uploads that the evidence does not determine.
- `jdcloud_lowcode_create_table` requires `systemAdministrator === true` and explicit authorization-object ids. It creates the menu, writes the visual schema, and assigns authority in three ordered upstream requests. A later failure reports the created menu id instead of deleting an earlier resource without a transaction.
- The remaining tools describe fields, query records, and read one record. Field description accepts a child-table container whose upstream definition omits `value` when it supplies `children`, while leaf fields still require a valid type value. Type `4` creation submits a workflow task; the plugin does not expose approval, return, or rejection actions because the three write permissions do not authorize those decisions.
- JDCloud business codes `600`, `601`, and `602` clear the stored login through the authentication controller and fail the operation as authentication-required. Other business or transport failures preserve the login.

## Alternatives considered

- **Reuse the complete external `@jdcloud/api` package.** The harness needs a small Host-owned request set and different authorization timing, so copying its package structure would import unrelated browser assumptions and API surface.
- **Fetch capabilities only after the model selects a tool.** The model would have to guess menu names and ids, and the capability information that informed its decision would not be durable Session input.
- **Expose the complete current-user response.** Full profile and menu data add model tokens and disclose fields that do not help type `3` or type `4` operations.
- **Treat prompt guidance or tool schemas as authorization.** Both are model-facing descriptions and can be bypassed by another executor caller; the Host operation that sends each request enforces the permission instead.
- **Let the confirmation prompt be the only required-field check.** Alternate callers and mistaken model output can bypass conversation guidance, so the create executor validates the current upstream field definition before it writes.
- **Automatically roll back a partly created table.** The upstream sequence has no transaction, and deleting an earlier resource after an uncertain later failure can destroy a resource that the server accepted; the package reports partial creation for explicit recovery.

## Consequences

- Every admitted browser prompt adds one current-user request after the tenant-list admission request. Tool continuations in the same Turn reuse the recorded snapshot and do not repeat capability discovery. Every create attempt that passes menu authorization adds one live field-definition request before validation or modification.
- The model sees only forms and workflows that the current response exposes. A tenant switch makes that snapshot unusable until the next admitted browser prompt, and other permission changes made during a Turn also take effect on that prompt.
- Create conversations can use known facts to fill any supported field without an unnecessary follow-up question, while the complete confirmation table keeps optional values such as attachments visible. Missing required values still block the Host request even if the model omits them from its confirmation.
- Read access and each write grant remain distinct. Menu visibility never implies create, edit, delete, or table-creation authority.
- Table creation can leave a menu or schema when a later request fails; operators use the returned menu id to inspect and repair that partial resource.
- The package deliberately gives up workflow approval operations and arbitrary low-code API access. The package README owns the consumer-facing behavior and limits.
