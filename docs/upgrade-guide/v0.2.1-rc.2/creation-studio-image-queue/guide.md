---
kind: upgrade-guide
description: "Creation Studio image task responses include queued work before provider submission."
---

# Creation Studio image tasks can be queued

English | [中文](guide.zh.md)

## Change

`images/tasks` can return `status: "queued"` before an account is assigned. Previously, an account at its concurrency limit caused the image task to fail. Accepted images now wait for a slot in the Host. Missing or invalid accounts still fail. Submitted requests with unknown outcomes never resubmit.

## Migration

1. Deploy the matching Creation Studio frontend and Harness together. Treat `queued` as active work alongside `pending`; continue querying the original `requestId` and `taskId`.
2. Preserve the configured `stateDirectory`. Host shutdown retains unsubmitted queued receipts; authenticated `images/refresh` or a repeated submission with the original parameters resumes that accepted work.
3. Verify with `pnpm exec vitest run packages/jdcloud/creation-studio-media/tests/runtime.spec.ts -t 'queues eight accepted images'`. Eight images under a five-slot account must finish without more than five simultaneous provider calls.
