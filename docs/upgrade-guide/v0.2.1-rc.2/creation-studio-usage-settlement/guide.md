---
kind: upgrade-guide
description: Creation Studio usage writes store settled decimal yuan amounts instead of integer micro amounts.
---

# Creation Studio usage fees write settled

English | [中文](guide.zh.md)

## Change

The Creation Studio media plugin writes calculated customer fees to low-code usage table `6ad81c871f280486bb45ac5b` with `chargeStatus=settled` instead of `ready`. This applies to both record creation and recovery updates. Execution `status` is unchanged; missing usage or prices remains `pending`, and platform-funded calls remain `waived`. Local receipts and tool consumption results retain `ready`. The migration preserves existing synchronized execution and charge statuses.

The amount fields change from `customerChargeMicros/gatewayCostMicros` to `customerCharge/gatewayCost`. Values are yuan/credit strings rounded half up to two decimal places per call: `320000` micro-yuan becomes `"0.32"`. Project totals sum rounded calls. Quotes and tool consumption also return two decimal places. Price rates retain their precision. Historical local receipts convert on read without repricing.

New usage records and billing list/sync responses use `metered` instead of `shadow`. Historical receipts retain their recorded mode, including the legacy `shadow` value. Video provider task IDs remain in `providerRequestId`, independently of local `requestId` and the business-task association `taskId`. Recovery no longer updates an already settled row; conflicting fees or provider IDs require review.

## Migration

1. Stop old writers. Back up the usage table, field permissions, dependent query projections, and deduction assistants. Migrate historical amounts by dividing by 1000000 and rounding half up to two decimals, keeping unknown amounts empty and deduction assistants disabled during the migration.
2. Rename both fields in the table, permissions, query projections, frontend, Skills, and automation. Deduction formulas use `customerCharge` directly without division. Retain each assistant's original enabled state.
3. Deploy the updated frontend, Skills, and `@deepseek-ai/dsh-creation-studio-media` Host together. Update filters to accept `settled` for new writes and both `ready/settled` for historical reports. Verify a fully priced call stores the decimal amount with its original execution status; verify project totals equal the sum of rounded call amounts.
4. Add `metered` to usage-table `billingMode` options and make it the default; retain `shadow` for history. Existing integrations must accept `mode=metered` in billing responses. Do not rewrite settled usage records to change their mode: update-triggered assistants can deduct again. Verify a new video receipt retains its real provider task ID and recovery performs no second update of its settled row.
