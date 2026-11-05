---
kind: upgrade-guide
description: "Creation Studio stage recommendations count toward customer usage after upgrading."
---

# Creation Studio recommendation usage is customer-funded

English | [中文](guide.zh.md)

## Change

The Creation Studio media plugin previously classified stage recommendation requests as platform-funded. New authenticated recommendation operations now use the submitting user's project and published Token prices. Provider-error attempts and automatic turns without a current user operation remain platform-funded. Existing receipts retain their recorded payer; this change does not debit a wallet.

## Migration

1. Deploy the updated Harness build and preserve the media plugin's `stateDirectory`.
2. Generate stage recommendations for an authenticated project and inspect the synchronized usage receipt: `skillNames` contains `creation-studio-stage-recommender`, `payer` is `customer`, and reported Token usage determines the calculated charge.
3. Keep previous receipts unchanged. Missing usage or prices remain pending; failed provider attempts remain platform-funded.
