---
kind: upgrade-guide
description: "Creation Studio reference-video uploads wait for a slot instead of returning HTTP 429 when an analysis is active."
---

# Creation Studio reference-video upload queue

English | [中文](guide.zh.md)

## Change

The `quote`, `analyze`, and `prepare-source` routes under `/api/external/v1/creation-studio/video-remake/` wait for an upload slot when work is in progress. Overload returns HTTP 503 with `video-remake/queue-full`, and an expired wait returns HTTP 504 with `video-remake/queue-timeout`. Receipt lookup through `status` can run while an upload occupies the worker slot. The default `videoRemake.concurrency` value is `auto`. Harness uses the advertised worker capacity after the first probe. An explicit number caps that capacity.

## Migration

1. Update clients that check for HTTP 429. Await the original request and keep the same confirmed request ID if a retry is needed. Allow the configured `videoRemake.timeoutMs` for proxied requests, including time spent waiting.
2. Update the worker image, Harness image, and Compose overlay together to enable automatic sizing. Check the `slots` value in the worker startup log. Set `videoRemake.concurrency: 1` to request serial admission, or set `videoRemake.maxQueued` to change the default of eight waiting requests.
