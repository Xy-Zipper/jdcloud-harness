---
kind: upgrade-guide
description: "New Creation Studio video remakes use Seedance output directly and apply provider limits to uploaded background music."
---

# Creation Studio remakes use Seedance for the final cut

English | [中文](guide.zh.md)

## Change

New `video/tasks` remake requests send the full source video to Ark for original-video edits, including `redoSelected` jobs that previously sent a reel. The model handles visual edits, sound, and subtitles. The selected timestamps guide generation, and the full source duration governs limits and the estimate. The saved output uses the provider's MP4 and may differ from the original cut or mix. Uploaded background music must be MP3 or WAV, at most 15 MB, and 2 to 30 seconds for Seedance 2.5 or 2 to 15 seconds for the 2.0 series. M4A and longer files can still appear on existing receipts.

## Migration

1. Deploy the Creation Studio frontend and Harness together. Enable an Ark video account for the model you use for original-video editing. Keep `CREATION_STUDIO_VIDEO_REMAKE_WORKER_URL` configured for source analysis and resuming receipts that have local assembly plans.
2. Replace unsupported music files in the BGM panel before submitting a new remake. Confirm that the dialog shows the whole-source estimate for an edit of selected shots. Refresh any previously submitted task with its original request ID to finish the existing upload.
