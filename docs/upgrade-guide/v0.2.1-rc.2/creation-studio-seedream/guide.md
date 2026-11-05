---
kind: upgrade-guide
description: "Creation Studio image submissions use Seedream instead of GPT Image and accept two model IDs with at most ten references."
---

# Creation Studio images use Seedream and private account pools

English | [中文](guide.zh.md)

## Change

New Creation Studio image submissions use Seedream 5.0 pro or flash through Ark. `imageModel` accepts `doubao-seedream-5-0-pro-260628` or `doubao-seedream-5-0-flash-260915`; it defaults to pro. Image plans and tools accept `model`, and references are limited to ten. Image requests support eight aspect ratios and 1K/1.5K/2K dimensions; `images/quote` reads published pixel-tier and reference-input prices without a provider call. New white-background tasks use the same Seedream models; old Jimeng tasks retain their original recovery path. Host task endpoints remain available, but Seedream execution runs in a Host-owned background operation instead of a remote asynchronous GPT task. Unknown or interrupted submissions never resubmit automatically. Existing GPT task receipts retain their original query and retry implementation.

## Migration

1. Update the Creation Studio frontend, both storyboard/image Skill ZIP files, and the JDCloud Harness deployment together. Replace any explicit GPT `imageModel` value in `cordis.yml` or overlays with a supported Seedream ID.
2. Maintain credentials in the administrator-only account table `6aead43ac3ca9f3dcdaf4b23`. Select concrete supported names such as `Doubao-Seedream-5.0-flash` in `models`; stored values are exact API model IDs. Preserve channel metadata for routing, and do not create duplicate key rows for different models sharing one quota. Configure `CREATION_STUDIO_ACCOUNT_POOL_USERNAME` and `CREATION_STUDIO_ACCOUNT_POOL_PASSWORD` with a dedicated tenant service login restricted to tenant identity and private table reads. The Host caches its token in memory and logs in again once on expiration; no fixed token is required. Do not grant normal callers access to that table. Keep unique account codes, supported `scenarios`, `enabled`, and positive `maxConcurrent`.
3. Preserve the complete `stateDirectory`, including `provider-calls`, and let one Host own it exclusively. Retain old GPT credentials until existing tasks finish. Without a pool reader, existing Ark and Jimeng environment keys remain numbered single-account credentials; once configured, pool read failures do not fall back.
4. Submit a test image with the selected model and check its returned `providerAccountRef`, generated project material, and usage row. Supply matching published Ark/Seedream prices; old GPT prices do not apply. Check video and white-background refreshes keep their original account. See the [media package](../../../../packages/jdcloud/creation-studio-media/README.md) for failure and capacity semantics.
