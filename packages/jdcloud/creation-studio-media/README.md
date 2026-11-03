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
| `imageModel` | `gpt-image-2.5` | Image provider model |
| `imageRetryLimit` | `2` | Maximum automatic replacement tasks after the specific retryable provider failure |
| `imageKeyRef` / `arkKeyRef` | `GPT_IMAGE_API_KEY` / `ARK_API_KEY` | Host credential references |
| `billingWriterKeyRef` | `CREATION_STUDIO_BILLING_WRITER_TOKEN` | Optional restricted JDCloud credential for shadow usage synchronization |
| `jimengAccessKeyRef` / `jimengSecretKeyRef` | `JIMENG_ACCESS_KEY_ID` / `JIMENG_SECRET_ACCESS_KEY` | Host-only Jimeng Visual API signing credentials |

Set `GPT_IMAGE_API_KEY` and `ARK_API_KEY` on the Harness server or in its credential store. Compose passes these variables into the container and stores media state under its existing persistent `data/creation-studio-media` directory. Install the Creation Studio Skill ZIP files separately through Skill management.

The frontend continues to proxy `/harness-api` to Harness. Its authenticated media routes retain `/api/external/v1/creation-studio/media/*`; the gateway needs a read timeout above 420 seconds. Missing provider keys leave Harness startup available and report generation as unconfigured.

Before moving existing tasks, stop the old executor and copy its images/seedance receipts into the corresponding subdirectories of `stateDirectory`. Keep the same directory when replacing a container. Resume uploads with the original request ID; an unknown paid submission must be checked with the provider before creating another request.

Batch storyboard images use `creation_studio_image_task` and the authenticated POST routes `images/tasks`, `images/refresh`, and `images/list` below the media prefix. Submit creates one `n=1` asynchronous provider task per missing image with `gpt-image-2.5`. Reference edits use a raw JSON body with `images` containing verified platform preview URLs and omit Content-Type; text generations use JSON Content-Type. Both use `async=true`, `response_format=url`, and one `Bearer ` prefix followed by the resolved image key. Submit returns the persisted request and task IDs without waiting for image completion.

Refresh queries the saved provider ID and downloads content only after `completed`, follows HTTPS redirects without forwarding the provider key to another origin, decodes the file, and resumes project uploads. `succeeded` includes the saved image in `result`; `pending`, `upload_pending`, and `upload_failed` retain the original request. Only explicit `failed` with `image generation failed; please retry` permits automatic replacement, up to `imageRetryLimit`; retry counts and previous task IDs persist under the same request ID. Authentication or other client rejection returns `failed` with `image/provider-rejected`; ambiguous submission remains `unknown` and never retries automatically. Existing unknown receipts require provider verification before a new request. List creates no task. Provider generation continues while the page is closed; download, eligible replacement, and platform upload resume on an authenticated refresh. The synchronous route remains available for existing single-image callers.

For batch refresh, send `projectId`, `planId`, `spaceId`, and a nonempty `taskIds` array; the response is an array of task views. Every ID must belong to that project, plan, and space before any provider query starts. Downloads and uploads run independently, and one query failure returns `refresh_failed` for that item without hiding other results. Remove `succeeded` items from later requests and follow the returned `taskId` after a replacement. The single-request `requestId` form remains available to tools. Invalid creative or script confirmation stops generation with `creation-studio/stale-confirmation` and an instruction to reconfirm that stage.

Seedance video tasks preserve confirmed script narration, subtitles, music, and sound effects. Storyboard speaker selections resolve to readable records in the tenant voice catalog; shared voices have no space ID, and private voices must match the project space. The Host downloads each selected audio file, measures its duration, and submits `audio_url` with `reference_audio`. Samples must be MP3 or WAV, 2–30 seconds each, at most 15 MB each and 30 seconds combined; each request accepts at most ten distinct voices. The prompt maps each speaker and original line to `@音频N` and uses samples only as voice references. Invalid, missing, or inaccessible voices stop submission before a paid provider request; existing task refreshes retain their original parameters.

Jimeng white-background images use authenticated POST `white-background/tasks`, `white-background/refresh`, and `white-background/list`. Configure both Jimeng credential references on the Host; these differ from the ARK bearer key. Submission requires a current-space project and an owned or commercially usable image material, but no adopted plan. The Host normalizes a separate JPEG reference, signs the Visual API request with the official signer including the required `content-type` header, fixes `req_key=jimeng_t2i_v40`, `force_single=true`, and 2048×2048 output, and appends the user's subject instructions to the white-background prompt. The prompt removes poster copy, floating logos, and text outside the product while preserving lettering physically printed on the product or packaging, including keyboard legends. The original stays unchanged. One returned image is validated, uploaded, and linked as a generated project material with its original-material reference; other projects in the same space can reuse it. Stable request IDs recover generation and upload progress; unknown paid submissions are never resubmitted. Usage records identify provider `jimeng`; without a matching published price, fees remain pending.

-----

Shadow billing records authenticated Creation Studio model attempts from durable assistant events without adding model messages. Normal provider usage belongs to the submitting user and space; recommendation requests and provider-error attempts are platform-funded. Missing usage or prices stays pending. Video receipts retain `completion_tokens` before download and never add `total_tokens` again. Image/video customer fees become ready only after project upload; no wallet, reservation, or ledger writes occur.

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
