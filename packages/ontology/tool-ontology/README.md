---
description: "Model-facing Ontology Runtime tools for Project draft modeling, authorized discovery, bounded Object queries, Link traversal, and prepared Action execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ontology

English | [中文](README.zh.md)

## Summary

Use `dsh-tool-ontology` to add Object, Property, Link, and Action definitions to Project drafts, or inspect and change business data through published definitions. The modeling skill reads business requirements and attachments, reuses existing definitions, and summarizes saved additions. Runtime enforces administrator access, draft revisions, and references before saving additions atomically. Published-data operations retain their discovery and prepared-Action workflow; no tool publishes a draft or exposes credentials.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package after `dsh-api-ontology-auth-controller`, `dsh-system-prompt`, and `dsh-tools`:

```yaml
- name: '@deepseek-ai/dsh-tool-ontology'
```

The package has no configuration fields. Runtime address, HTTPS policy, deadlines, and browser credentials belong to the authentication controller.

### Operation order

1. Call `ontology_list_projects`, then pass one returned `project_id` to later discovery and read tools.
2. Call `ontology_list_objects` and `ontology_describe_object` before using Property, Link, or Action ids.
3. Call `ontology_describe_action` to read the exact required and optional parameters and the confirmation requirement. Present each parameter's business `label`, technical `inputName`, and required status; pass `inputName` as the key to `ontology_prepare_action`.
4. Call `ontology_prepare_action` with the described Action parameters; retain its immutable `invocationId` and preview.
5. Call `ontology_execute_action` with only that invocation id. The tool rereads the Invocation, presents Runtime's summary when confirmation is required, and sends the write only after a one-shot approval. Treat the write as successful only when Runtime returns `status: succeeded`.

Query and traversal pages default to 20 records and reject a `page_size` above 100. Equality filters use Property ids from Object detail, never source-column names. The Host generates the preparation idempotency key; execution accepts no replacement parameters. A rejected approval performs no execution request, and a sequential retry rereads the Invocation instead of reusing the earlier preview.

### Draft modeling

Call `ontology_get_draft` with the current management Project id, including for an unpublished Project. Reuse its existing definitions, data-source ids, and trusted executor keys. Send additions through `ontology_add_draft_resources` with that exact `project.updatedAt` as `expected_updated_at`; nested definitions use the draft's camelCase fields. The Runtime rejects stale revisions and conflicting definitions without saving part of the batch. Read the draft again before retrying a conflict. Embedded modeling calls must match the Project transferred by the management page.

Use `ontology_inspect_data_source` to discover actual resource names and field metadata through the Project gateway. Correct existing `resourceRef`, `primaryKey`, and Property `sourceField` values with `ontology_update_draft_bindings` and the latest draft revision. Business Property ids remain stable; they do not have to match physical field names. Runtime validates the addressed resources and mapped fields before atomically saving the batch, preserving relationships and releases.

When a Skill registry is present, the plugin contributes the packaged [`ontology-modeler`](assets/ontology-modeler/SKILL.md) skill for both user and model invocation. It guides attachment analysis, additive modeling, incomplete data-source mappings, and summaries of saved additions. Definitions remain drafts until the user validates and publishes them through the management application.

### Failures and recovery

The package validates every Runtime JSON response before returning it to the model. Invalid arguments fail before a request; authentication, authorization, transport, stale Invocation, and response-validation failures become tool errors and do not produce a partial business result. Runtime rechecks authorization during execution, so a permission change while confirmation is pending is shown as the execution error. Discover ids again after a Project publication or permission change instead of reusing an earlier result.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each registration builds one fixed `/api/runtime/` request and delegates its Bearer Token to the Host-only authentication controller. The controller revalidates the browser login before every call; this package deliberately keeps no Project manifest or authorization cache. The execution gate reads the server-owned Invocation immediately before approval, rejects every status except `prepared`, and uses the shared approval service so the existing Web panel supplies confirm, reject, and duplicate-click disabling. Runtime owns the final atomic claim, authorization recheck, write, and audit record.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Published and draft tools, fixed Runtime requests, current-Project enforcement, and Action approval. |
| [`src/runtime.ts`](src/runtime.ts) | Runtime response validation, Invocation status checks, and bounded result projection. |
| [`src/draft.ts`](src/draft.ts) | Draft response validation and credential-free modeling results. |
| [`src/modeling-skill.ts`](src/modeling-skill.ts) | Reversible registration of the packaged modeling instructions. |
| [`src/types.ts`](src/types.ts) | Branded published ids and model-result types. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ontology) — exact argument schemas as the model sees them.
- [Ontology Auth Controller](../../api/ontology-auth-controller/README.md) — browser-scoped login and Host-only Runtime transport.
- [Ontology login bundle](../../bundle/ontology-login/README.md) — complete Web-profile layer.
- [Ontology package group](../README.md) — ownership map for this capability family.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The package adds one fixed discovery and Action-ordering paragraph.

##### Ontology guidance

```markdown
Use Ontology tools only with ids returned by discovery. List Projects before selecting one, list and describe Objects before querying their Property ids or Link ids, and never guess ids. Describe a selected Action before preparation to discover its required and optional parameters and confirmation requirement. Present each Action parameter to users by its business label, technical inputName, and required status. Prepare every Action before execution. Execute only the invocation_id returned by preparation; do not claim a write succeeded until ontology_execute_action returns status succeeded.
```

#### Token effect

One fixed concise section is present on each request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while the plugin, tool visibility, and guidance text are unchanged.

### Tool schemas

#### What the model sees

The model sees the generated [published-data and draft-modeling schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ontology). Stable ids, bounded record pagination, and the required draft revision are explicit; Runtime tokens and data-source credentials are absent.

#### Token effect

Thirteen fixed schemas are sent on each request while visible. The optional Skill registry advertises one modeling skill and loads its instruction body only when invoked.

#### KV Cache effect

Prefix-stable while the tool definitions and visibility are unchanged.

### Tool results

#### What the model sees

Every successful call returns bounded JSON. Discovery returns published ids and labels; Action detail returns exact parameters with the business `label`, technical `inputName`, and `required` status first; reads return validated records keyed by Property id; preparation returns an invocation id, expiry, confirmation requirement, summary, and affected Objects. Before a confirmed execution, the user sees Runtime's summary, Action and Project ids, and a bounded affected-Object list; rejection returns a tool error without executing. Execution returns only a succeeded invocation and its Runtime result. Tool failures return an error instead of unvalidated Runtime fields. Draft results contain Project metadata, the current revision, definition arrays, and safe executor metadata; additions also return counts for each resource category. Data-source connection references and executor implementation fields are omitted.

#### Token effect

Results are data-dependent and remain in logged tool history until compaction; record lists are bounded by the requested page size of at most 100.

#### KV Cache effect

Append-only call and result content follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web request identity** — calls require a browser request carrying an active Ontology login; background execution without that request-local identity is rejected.
- **Equality-only filters** — Object queries currently expose Property-id equality filters, not arbitrary expressions, sorting, aggregation, or joins.
- **Explicit Project selection** — every Project-scoped call requires `project_id`; the package does not maintain a mutable current Project.
- **Draft additions and binding corrections** — modeling requires administrator access and cannot delete, publish, or execute definitions. Field discovery uses the gateway's schema metadata; a sampled MongoDB schema can omit fields absent from its sample or fail for an empty collection.
- **Runtime-owned writes** — supported Action operations depend on the published Ontology Runtime and its data-source providers; the Harness cannot bypass a read-only source or unsupported provider operation.
- **Approval policy** — a session whose shared approval policy is `never` rejects confirmation-required Actions instead of bypassing the Runtime requirement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Each call validates the current browser login and the Runtime response before returning model-visible JSON.
