---
kind: upgrade-guide
description: "Creation Studio video submissions require Host original-image receipts for Seedream text-to-image references."
---

# Preserve original images for Creation Studio video

English | [中文](guide.zh.md)

## Change

Creation Studio previously downloaded every video reference from low-code storage and submitted its Base64 bytes. Seedream text-to-image references now use the original provider URL and the same Ark account that generated them. The Host verifies the image and upload receipts, file binding, and URL expiry before video submission.

Legacy text-to-image materials without an original URL or Host receipt cannot use this path. Missing or expired originals stop submission; the Host does not change accounts, substitute low-code bytes, or create a paid replacement.

## Migration

1. Deploy the matching Creation Studio frontend, media package, and requirement, storyboard, image-generation, and video-generation Skill ZIPs.
2. Retain `stateDirectory/images`, `stateDirectory/uploads`, and `stateDirectory/provider-calls` together, and keep the original Ark account enabled for the selected video model.
3. For legacy or expired text-to-image references, return to storyboard and explicitly plan and confirm a new text-to-image request if needed. For faces, use no reference images. Do not add an invented original URL to a low-code record.
4. Confirm that the material's `generatedImage` retains `originalUrl` and `originalUrlExpiresAt`, and that video submission uses the recorded provider account. Missing or expired originals must show an actionable error before a video provider call. See the [media package](../../../../packages/jdcloud/creation-studio-media/README.md) for validity and review requirements.
