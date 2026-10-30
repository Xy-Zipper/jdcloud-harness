---
kind: upgrade-guide
description: "Custom SessionPersistence backends must implement permanent Session deletion."
---

# Implement SessionPersistence.delete

English | [中文](guide.zh.md)

## Change

`SessionPersistence` requires `delete(id: SessionId): Promise<void>`. Custom subclasses must implement it to support permanent Session deletion from the GUI. The shipped JSONL provider implements the method; existing logs need no conversion.

## Migration

1. Implement `delete` in each custom `SessionPersistence` subclass. Require the caller to stop producers, drain and close local write handles, refuse foreign write ownership, and remove provider-owned Session storage. An absent id must succeed without changes; storage failures must reject.
2. Keep project files and globally shared attachment objects outside this operation.
3. Compile the backend and verify that deleting one Session removes its stored files and list entry without affecting another Session or project files.
