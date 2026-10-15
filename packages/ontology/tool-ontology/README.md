---
description: "Model-facing Ontology Runtime tools for authorized Project discovery, bounded Object queries, Link traversal, and prepared Action execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ontology

English | [中文](README.zh.md)

## Summary

Use `dsh-tool-ontology` when an agent must inspect and change business data through published Ontology definitions. Nine stable tools discover authorized ids, describe Objects and Actions, perform bounded record reads and Link traversal, and prepare then execute Actions. Every call uses the current browser login and asks Runtime to enforce current Project and Action authorization; the package stores no token, capability cache, data-source secret, or business record.

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
| [`src/index.ts`](src/index.ts) | Prompt guidance, nine tool schemas, fixed Runtime requests, Action approval gating, pagination, and idempotency keys. |
| [`src/runtime.ts`](src/runtime.ts) | Runtime response validation, Invocation status checks, and bounded result projection. |
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

The model sees the generated [`ontology_list_projects`, `ontology_list_objects`, `ontology_describe_object`, `ontology_describe_action`, `ontology_query_objects`, `ontology_get_object`, `ontology_traverse_link`, `ontology_prepare_action`, and `ontology_execute_action` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ontology). Stable ids and bounded pagination are explicit; Runtime tokens, data-source credentials, table names, and raw write expressions are absent.

#### Token effect

Nine fixed schemas are sent on each request while visible.

#### KV Cache effect

Prefix-stable while the tool definitions and visibility are unchanged.

### Tool results

#### What the model sees

Every successful call returns bounded JSON. Discovery returns published ids and labels; Action detail returns exact parameters with the business `label`, technical `inputName`, and `required` status first; reads return validated records keyed by Property id; preparation returns an invocation id, expiry, confirmation requirement, summary, and affected Objects. Before a confirmed execution, the user sees Runtime's summary, Action and Project ids, and a bounded affected-Object list; rejection returns a tool error without executing. Execution returns only a succeeded invocation and its Runtime result. Tool failures return an error instead of unvalidated Runtime fields.

#### Token effect

Results are data-dependent and remain in logged tool history until compaction; record lists are bounded by the requested page size of at most 100.

#### KV Cache effect

Append-only call and result content follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web request identity** — calls require a browser request carrying an active Ontology login; background execution without that request-local identity is rejected.
- **Equality-only filters** — Object queries currently expose Property-id equality filters, not arbitrary expressions, sorting, aggregation, or joins.
- **Explicit Project selection** — every Project-scoped call requires `project_id`; the package does not maintain a mutable current Project.
- **Runtime-owned writes** — supported Action operations depend on the published Ontology Runtime and its data-source providers; the Harness cannot bypass a read-only source or unsupported provider operation.
- **Approval policy** — a session whose shared approval policy is `never` rejects confirmation-required Actions instead of bypassing the Runtime requirement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Each call validates the current browser login and the Runtime response before returning model-visible JSON.
