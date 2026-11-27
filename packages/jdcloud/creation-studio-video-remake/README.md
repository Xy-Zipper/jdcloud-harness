---
description: "Deploy the authenticated Creation Studio reference-video analyzer."
kind: "package-reference"
---

# @deepseek-ai/dsh-creation-studio-video-remake

English | [中文](README.zh.md)

## Summary

Creation Studio users can upload an MP4 or MOV to carry cuts and timed dialogue into a new project. Harness authenticates the caller and delegates media decoding and analysis to the private rea-video worker.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use [the optional Compose overlay](../../../compose.video-remake.yaml) with the [JDCloud Harness deployment](../../../Docker.README.md). Set the worker URL and both rates to enable quoting and analysis. The worker has no published port, model keys or internet route. Each request removes its temporary files.

Both `POST /api/external/v1/creation-studio/video-remake/quote` and `POST /api/external/v1/creation-studio/video-remake/analyze` accept original file bytes, `Authorization: Bearer …` and `X-Tenant-Id`. The worker verifies the duration and limits uploads to 4–30 seconds, 30 MiB, 1080p in either orientation and 60 fps. The quote includes measured seconds and bytes, the rates and the total in hundredths of a point. Each rate applies to its unit rounded up.

Video uploads for quotes, analysis, and source conversion wait for a worker slot. Harness admits eligible requests in arrival order and runs paid analyses from the same space one at a time. Up to eight requests wait by default, and the default 210-second deadline includes waiting. While queued, Harness leaves the request body unread. Disconnecting removes the waiter before charging. A full queue returns HTTP 503 (`video-remake/queue-full`), and an expired wait returns HTTP 504 (`video-remake/queue-timeout`). Receipt checks run independently of the upload queue.

At startup, the worker budgets two logical CPUs and 1.5 GiB per slot, with headroom of two logical CPUs and 2 GiB for other host workloads. It uses the process's CPU affinity, available host memory, and any tighter cgroup v1 or v2 limits to pick one to four slots. The startup log records `slots`, `cpu_budget`, and `memory_budget_mib`. The default `videoRemake.concurrency: auto` starts at one slot and uses the capacity advertised by `/probe`. A numeric setting caps the advertised capacity, or sets the admission limit for a legacy worker that supplies no capacity header. Queue size and deadline use `videoRemake.maxQueued` and `videoRemake.timeoutMs` on the media plugin.

Supply the full authorization value returned by JDCloud after the outer `Bearer` prefix, including any scheme in the original value. Harness passes that value to JDCloud to verify the account and tenant.

Send `X-Studio-Space-Id`, `X-Studio-Request-Id` (UUID v4) and `X-Studio-Remake-Max-Cents` (the approved ceiling in hundredths of a point) with analysis. Harness checks editing permission and available points. The media plugin saves the cuts and timed `dialogue` lines together and verifies the debit before returning the result. An empty `dialogue` array records a completed recognition with no speech detected. `video-remake/transcript-unavailable` leaves the new request uncharged and can be retried with the same confirmation.

Use a bodyless `POST /api/external/v1/creation-studio/video-remake/status` with the same authentication and confirmation headers to check the original operation. A 200 response returns the saved result. Older receipts contain cuts only. `settlement-pending` means the debit could not yet be matched. `settlement-check-unavailable` means a settlement source could not be read. Both can be rechecked without an upload. `settlement-conflict` requires review. If the first upload was interrupted or returned `settlement-sync-pending`, resend the original bytes and confirmation to recover that operation.

`POST /api/external/v1/creation-studio/video-remake/prepare-source` accepts the original MOV bytes and the same authentication and confirmation headers. Harness matches the file digest to the settled analysis receipt. The private worker returns an H.264 MP4 with AAC audio tracks for project storage. Conversion reuses the saved analysis and adds no charge.

For a tenant whose automation debits the space balance directly, configure `videoRemake.balanceDebitAssistant.id` and `nodeId` with the data assistant and its debit node. The active JDCloud bundle sets these for Creation Studio. Verification reads recent assistant runs with the caller's existing permission when the points ledger has no debit.

New remake tasks use the worker for analysis and source preparation. The media plugin calls `/merge-edit`, `/mix-bgm`, and `/sync-captions` only when resuming an upload with a local assembly plan in its receipt. `/merge-edit` assembles the generated edit on the source timeline and copies compatible original audio by default. The endpoints use bounded local files and remove temporary data after each operation.

The worker advertises `X-Remake-Output-Settings: 1` on successful preparation and assembly responses. Pass the JSON object `{}` in that header on `/merge-edit` to fit the source aspect ratio into the generated video's dimensions. For a model that generates a fixed integer duration, pass its requested `seconds` in the object to fit the render onto the source timeline. Whole-video edits without fixed `seconds` accept a duration difference up to 0.4 seconds and retime the picture to the original timeline when the difference exceeds 0.2 seconds.

The worker image installs SenseVoice, voice activity detection, and the vocal separation model at build time. `/transcript` accepts `X-Remake-Ranges` with a JSON array of cut boundaries, beginning at zero and ending at the source duration. It returns timed lines with a one-based `shotNumber`. `X-Remake-Audio-Edit: 1` on `/probe` advertises whole-clip generation audio support. `/merge-edit` accepts `audio: "generated"` or `audio: "keep-music"` in the output settings. With `keep-music`, it combines separated original music with the edited vocal track.

For a saved music plan, `/mix-bgm` preserves the video stream and mixes the selected span under the separated vocals. It crops or repeats the uploaded segment to match the picture duration. Separation quality depends on the original mix, and sound effects may change.

For a saved subtitle plan, `/sync-captions` takes a composed MP4 followed by a JSON plan of up to 256 KiB. `X-Remake-Source-Length` marks the end of the MP4. The worker uses the saved dialogue text and time windows to render captions, copies the audio, and checks the result size. In original-video edits it retains untouched text cues and removes detected residual burned captions that match the original text and position in edited intervals. The worker image bundles OCR and a Chinese subtitle font. MOV preparation retains compatible text tracks.

-----

<a id="model-experience"></a>
## Model Experience

### Reference-video analysis

#### What the model sees

The HTTP `analyze` action registers no tool and creates no session event. The worker measures shot boundaries and transcribes the full first audio track locally. Recognized words are assigned by their onset, and each line is confined to one shot in new results. The [media plugin](../creation-studio-media/README.md) includes shot numbers, time windows and confirmed dialogue edits in the generation request.

#### Token effect

Analysis uses local CPU, memory and temporary disk space without consuming model tokens. Successful analysis is charged by measured duration and upload size.

#### KV Cache effect

The plugin adds no prompt prefix or tool definition.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Machine transcription may miss speech in quiet or overlapping passages. Creation Studio lets users add dialogue and label its speaker. OCR can miss burned captions that appear briefly, use handwriting, or move across the picture. Visual interpretation and provider generation run outside analysis. The ledger integration uses a single Harness Host per receipt directory.

<a id="dev-note"></a>
### Dev Note

None.
