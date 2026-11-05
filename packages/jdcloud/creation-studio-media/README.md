---
description: "Configure Creation Studio image generation, Seedance video tasks, and authenticated project uploads in Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-creation-studio-media

English | [中文](README.zh.md)

## Summary

Generate storyboard images and reference videos, then save their files and project references in the low-code platform. The JDCloud bundle includes this capability in the Harness build and deployment. Skills remain separately installed ZIP archives. Keys stay in Host credentials; generated images require user confirmation.

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

The [JDCloud bundle patch](../../bundle/jdcloud-login/cordis.patch.yml) mounts the plugin. The repository build emits its runtime and Docker includes it through that bundle; no creation-studio build step or separate media-plugin installation is required.

| Field | Default | Meaning |
|---|---|---|
| `platformURL` / `tenantId` | Required | Fixed platform and tenant; each caller must match |
| `stateDirectory` | Required | Persistent generation receipts and upload progress |
| `imageModel` | `doubao-seedream-5-0-pro-260628` | Image provider model |
| `imageRetryLimit` | `4` | Replacement budget for already-persisted legacy GPT tasks only |
| `imageKeyRef` / `arkKeyRef` | `GPT_IMAGE_API_KEY` / `ARK_API_KEY` | Host credential references |
| `accountPoolTableId` | `6aead43ac3ca9f3dcdaf4b23` | Private account table |
| `accountPoolUsernameRef` / `accountPoolPasswordRef` | `CREATION_STUDIO_ACCOUNT_POOL_USERNAME` / `CREATION_STUDIO_ACCOUNT_POOL_PASSWORD` | Host-only service login credentials |
| `accountPoolKeyRef` | `CREATION_STUDIO_ACCOUNT_POOL_TOKEN` | Optional legacy token; password login takes priority |
| `billingWriterKeyRef` | `CREATION_STUDIO_BILLING_WRITER_TOKEN` | Optional restricted JDCloud credential for shadow usage synchronization |
| `jimengAccessKeyRef` / `jimengSecretKeyRef` | `JIMENG_ACCESS_KEY_ID` / `JIMENG_SECRET_ACCESS_KEY` | Host-only Jimeng Visual API signing credentials |

Store Ark API keys and Jimeng AK/SK in the private account table. Set `CREATION_STUDIO_ACCOUNT_POOL_USERNAME` and `CREATION_STUDIO_ACCOUNT_POOL_PASSWORD` to a dedicated tenant account permitted to read only tenant identity and that table; never grant ordinary callers table access. The Host logs in for the configured tenant, caches the token only in memory, and performs one shared login plus one read retry on HTTP 401 or JDCloud 600/601/602. Permission and password failures do not loop or fall back. Credential changes replace the cached login. Compose passes these credentials into the container. A legacy `CREATION_STUDIO_ACCOUNT_POOL_TOKEN` remains optional when neither username nor password is configured. Without any reader credentials, numbered `ENV-ARK` and `ENV-JIMENG` credentials preserve single-key deployments; a configured but unreadable or empty pool never falls back. Keep `GPT_IMAGE_API_KEY` only while old GPT tasks need recovery. Install the updated Creation Studio Skill ZIP files separately through Skill management.

The frontend continues to proxy `/harness-api` to Harness. Its authenticated media routes retain `/api/external/v1/creation-studio/media/*`; the gateway needs a read timeout above 420 seconds. Missing provider keys leave Harness startup available and report generation as unconfigured.

Before moving existing tasks, stop the old executor and copy its images/seedance receipts into the corresponding subdirectories of `stateDirectory`. Keep the same directory when replacing a container. Resume uploads with the original request ID; an unknown paid submission must be checked with the provider before creating another request.

Storyboard image requests select `doubao-seedream-5-0-pro-260628` or `doubao-seedream-5-0-flash-260915`, defaulting to `imageModel`. The `model` field belongs to both the generation plan and tool arguments. Up to ten verified project references become the Ark `image` URL array. The Host calls `/api/v3/images/generations` with PNG Base64 output and no watermark; dimensions support eight aspect ratios at 1K, 1.5K, and 2K. Scene assets prefer 16:9; 16:9 and 9:16 are recommended. `images/quote` authorizes the project and references, returning current estimated credits without provider calls or account reservation. Image pricing selects actual decoded pixel bounds and charges input references beyond the per-request free allowance; completed tasks return `consumption`. `images/tasks` returns a Host task immediately while the synchronous provider request runs in an owned background operation. Disposal waits for receipt persistence. `images/refresh` resumes uploads and `images/list` never creates a paid task. Unknown submissions and interrupted requests after restart require provider verification and never automatically resubmit. Already-persisted GPT tasks retain their original query and bounded retry path.

Only accounts whose `models` contain the exact requested API model ID and whose `scenarios` include the requested service participate. Account forms select concrete names such as `Doubao-Seedream-5.0-flash`; channel fields remain private routing metadata. Several models on one key share one account and concurrency limit. Account allocation chooses the lowest in-flight count divided by `maxConcurrent`, randomizing equal loads, and rejects when every eligible account is full. Ark image and video tasks share capacity; new white-background tasks share Ark capacity; old Jimeng tasks retain their AK/SK pool. Reservations and per-call user, project, request, model, account ID/code, timestamps, and status persist under `stateDirectory/provider-calls` before submission without secrets. Unknown outcomes retain capacity. Completed or explicitly failed generation releases capacity; upload recovery never starts a new generation. Video and white-background queries resolve their original account even when disabled. Keep its original credentials until tasks finish. Shadow usage rows expose `providerAccountRef`, never keys. One Host exclusively owns the state directory; this is not a distributed scheduler.

For batch refresh, send `projectId`, `planId`, `spaceId`, and a nonempty `taskIds` array; the response is an array of task views. Every ID must belong to that project, plan, and space before any provider query starts. Downloads and uploads run independently, and one query failure returns `refresh_failed` for that item without hiding other results. Remove `succeeded` items from later requests and follow the returned `taskId` after a replacement. The single-request `requestId` form remains available to tools. Invalid creative or script confirmation stops generation with `creation-studio/stale-confirmation` and an instruction to reconfirm that stage.

Seedance video tasks preserve confirmed script narration, subtitles, music, and sound effects. Storyboard speaker selections resolve to readable records in the tenant voice catalog; shared voices have no space ID, and private voices must match the project space. The Host downloads each selected audio file, measures its duration, and submits `audio_url` with `reference_audio`. Samples must be MP3 or WAV, 2–30 seconds each, at most 15 MB each and 30 seconds combined; each request accepts at most ten distinct voices. The prompt maps each speaker and original line to `@音频N` and uses samples only as voice references. Invalid, missing, or inaccessible voices stop submission before a paid provider request; existing task refreshes retain their original parameters.

Seedream white-background images use the selected pro/flash model, explicit dimensions, and the Ark account pool. New tasks persist their model and size before the synchronous provider request. Historical Jimeng 4.0 receipts retain AK/SK recovery. The authenticated routes remain POST `white-background/tasks`, `white-background/refresh`, and `white-background/list`. Submission requires a current-space project and an owned or commercially usable image material, without an adopted plan. The Host normalizes a separate JPEG reference and applies the white-background prompt, preserving product lettering and requested multi-view composition. Generated results require visual review. The original stays unchanged. One returned image is validated, uploaded, and linked as a generated project material with its original-material reference; other projects in the same space can reuse it. Stable request IDs recover generation and upload progress; unknown paid submissions are never resubmitted. New usage records identify provider `ark` and the selected model; without a matching published price, fees remain pending.

-----

Shadow billing records authenticated Creation Studio model attempts from durable assistant events without adding model messages. Normal provider usage, including stage recommendations, belongs to the submitting user and space; provider-error attempts and automatic turns without a current user operation are platform-funded. Retained receipts keep their recorded payer. Missing usage or prices stays pending. Video receipts retain `completion_tokens` before download and never add `total_tokens` again. Image/video customer fees become ready only after project upload; no wallet, reservation, or ledger writes occur.

Each settled model call automatically synchronizes its receipt to the low-code usage table. If configured, the restricted writer credential takes priority; it needs tenant identity and usage-table read access plus create/update access only to usage records. Without it, the original submitter's current authenticated request supplies its existing permissions; the recorder stores no additional user token and refuses a changed account. Permission or network failures leave durable pending receipts. Turn completion retries pending records in the bound space and project in the background; authenticated POST `billing/list` also retries and recalculates pending records before returning the current space's local receipts in pages of 50. `billing/sync` performs the same recovery explicitly, with at most 50 records per operation. Receipts and verified session bindings persist under `stateDirectory/billing`. Updates use PUT; a lost create acknowledgement is checked by its original event key and never blindly recreated. A single Host owns each state directory; multiple writers need platform-side unique keys before financial use.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [plugin](src/index.ts) registers tools and HTTP routes against the same [runtime](src/runtime.mjs). The JDCloud controller owns caller identity, file access, and platform requests. Generation rechecks project confirmation and permissions, records provider receipts, then saves the uploaded file, material, and project relation in order. Disposal removes registrations and waits for pending operations to persist.

The migrated JavaScript execution modules retain their existing behavior and are emitted with the package's TypeScript build. Local request helpers mirror the frontend's persisted JSON fields; the runtime has no dependency on frontend source or installed Skills.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [JDCloud bundle](../../bundle/jdcloud-login/README.md)
- [Authentication controller](../../api/jdcloud-auth-controller/README.md)
- [Docker deployment](../../../Docker.README.md)

-----

<a id="model-experience"></a>
## Model Experience

### Media tools

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-creation-studio-media) defines the media tools, including asynchronous image submission, refresh, and list. Execution requires the current project context and returns task states or platform references without keys or generated binary data.

#### Token effect

The loaded plugin adds three tool schemas. Calls append arguments and media receipts to normal tool events.

#### KV Cache effect

Tool schemas remain stable while configuration is unchanged. Calls append history; changing the mounted tools can invalidate tool-prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The persisted table IDs and confirmation protocol target the Creation Studio tenant; another tenant needs matching tables and configuration.
- Video input uses image and selected voice references for Seedance 2.5 reference tasks. Live provider availability and voice matching quality require configured accounts and provider validation.
- Low-code record creation has no transactional idempotency key. A lost create response requires checking the platform before retrying.

<a id="dev-note"></a>
### Dev Note

None.
