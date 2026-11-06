---
kind: upgrade-guide
description: "Creation Studio project creation and new paid calls require readable positive space points."
---

# Creation Studio checks points before new paid calls

English | [中文](guide.zh.md)

## Change

The media plugin reads `points` from team-space table `6adb0fbec3ca9f3dcdaf499a` before project creation, every model request bound to a Creation Studio Session, and new paid image, video, or white-background submissions. Zero or negative values deny the new operation and ask the user to recharge. Missing, malformed, or unreadable values also stop the new operation. Existing-task queries and result saving remain available, as do record updates that do not make a paid model call.

## Migration

1. Make the `points` field readable by project creators on their current team space. Keep decimal text values; a positive fractional value is sufficient. Configure existing spaces through the established administrator or recharge process.
2. Deploy the updated Harness with the Creation Studio media plugin and the updated Creation Studio frontend.
3. Confirm that a zero-point space shows a recharge message without creating a project or issuing a new provider request. Existing paid tasks must still finish querying and saving their results. After adding positive points through the established process, retry and confirm that the new operation reads the new balance.

The check reads points only; it does not deduct or reserve them.
