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

Set `GPT_IMAGE_API_KEY` and `ARK_API_KEY` on the Harness server or in its credential store. Compose passes these variables into the container and stores media state under its existing persistent `data/creation-studio-media` directory. Install the Creation Studio Skill ZIP files separately through Skill management.

The frontend continues to proxy `/harness-api` to Harness. Its authenticated media routes retain `/api/external/v1/creation-studio/media/*`; the gateway needs a read timeout above 420 seconds. Missing provider keys leave Harness startup available and report generation as unconfigured.

Before moving existing tasks, stop the old executor and copy its images/seedance receipts into the corresponding subdirectories of `stateDirectory`. Keep the same directory when replacing a container. Resume uploads with the original request ID; an unknown paid submission must be checked with the provider before creating another request.

Batch storyboard images use `creation_studio_image_task` and the authenticated POST routes `images/tasks`, `images/refresh`, and `images/list` below the media prefix. Submit creates one `n=1` asynchronous provider task per missing image with `gpt-image-2.5`. Reference edits use a raw JSON body with `images` containing verified platform preview URLs and omit Content-Type; text generations use JSON Content-Type. Both use `async=true`, `response_format=url`, and one `Bearer ` prefix followed by the resolved image key. Submit returns the persisted request and task IDs without waiting for image completion.

Refresh queries the saved provider ID and downloads content only after `completed`, follows HTTPS redirects without forwarding the provider key to another origin, decodes the file, and resumes project uploads. `succeeded` includes the saved image in `result`; `pending`, `upload_pending`, and `upload_failed` retain the original request. Only explicit `failed` with `image generation failed; please retry` permits automatic replacement, up to `imageRetryLimit`; retry counts and previous task IDs persist under the same request ID. Authentication or other client rejection returns `failed` with `image/provider-rejected`; ambiguous submission remains `unknown` and never retries automatically. Existing unknown receipts require provider verification before a new request. List creates no task. Provider generation continues while the page is closed; download, eligible replacement, and platform upload resume on an authenticated refresh. The synchronous route remains available for existing single-image callers.

For batch refresh, send `projectId`, `planId`, `spaceId`, and a nonempty `taskIds` array; the response is an array of task views. Every ID must belong to that project, plan, and space before any provider query starts. Downloads and uploads run independently, and one query failure returns `refresh_failed` for that item without hiding other results. Remove `succeeded` items from later requests and follow the returned `taskId` after a replacement. The single-request `requestId` form remains available to tools. Invalid creative or script confirmation stops generation with `creation-studio/stale-confirmation` and an instruction to reconfirm that stage.

Seedance video tasks preserve confirmed script narration, subtitles, music, and sound effects. Storyboard speaker selections resolve to readable records in the tenant voice catalog; shared voices have no space ID, and private voices must match the project space. The Host downloads each selected audio file, measures its duration, and submits `audio_url` with `reference_audio`. Samples must be MP3 or WAV, 2–30 seconds each, at most 15 MB each and 30 seconds combined; each request accepts at most ten distinct voices. The prompt maps each speaker and original line to `@音频N` and uses samples only as voice references. Invalid, missing, or inaccessible voices stop submission before a paid provider request; existing task refreshes retain their original parameters.

-----

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
