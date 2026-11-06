---
kind: upgrade-guide
description: "New Creation Studio video batches require the Host to read explicit Seedance model selections."
---

# Preserve the selected Seedance model

English | [中文](guide.zh.md)

## Change

New Creation Studio video batches persist `generation.model` under `seedance-models-1`. The Host accepts Seedance 2.0, 2.0-fast, 2.0-mini, and 2.5 with their respective limits. An older Host rejects the new batch format. Legacy `seedance-2.0-1` and `seedance-2.5-1` batches remain readable; batches without a model retain the prior 2.5 default. Existing tasks continue with their saved model and request ID.

## Migration

1. Deploy the updated Creation Studio frontend and Harness together, and update the `creation-studio-video-generation` Skill ZIP.
2. Add the enabled model IDs to the existing video account's `models` field. Publish prices for each supported model, resolution, and input-video mode; keep keys, concurrency limits, and historical prices.
3. Save a batch after selecting its model. Confirm that the creation request, task receipt, and usage record all contain that model. Unsupported duration, resolution, or reference counts must stop before provider submission.
