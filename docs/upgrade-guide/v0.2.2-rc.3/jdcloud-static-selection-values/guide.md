---
kind: upgrade-guide
description: "JDCloud record tools reject static selection values outside the live stored option ids."
---

# JDCloud static selections require stored option ids

English | [中文](guide.zh.md)

## Change

`jdcloud_lowcode_create` and `jdcloud_lowcode_update` previously checked selection JSON types without checking static option membership. They now reload static `select`, `radio`, and `checkbox` options, including child tables, and reject unknown ids with `JDCLOUD_LOWCODE_FIELD_TYPE` before modifying a record. `jdcloud_lowcode_describe` adds an `enum` array of stored option ids. Dynamic selectors retain their existing behavior.

## Migration

1. Call `jdcloud_lowcode_describe` for the target menu and use each field's `enum` values in create or update data. Do not substitute a display label or an invented synonym. Optional single selections may still be cleared with an empty string.
2. If an option changes between describe and write, use the allowed ids in the error or describe the menu again. Confirm that valid ids save and invalid ids return `JDCLOUD_LOWCODE_FIELD_TYPE` without a record change. Existing records are not rewritten by this check.
