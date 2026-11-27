---
kind: upgrade-guide
description: "The Ontology assistant now opens a separate Workspace and conversation history for each selected Project."
---

# Project history in the Ontology assistant

English | [中文](guide.zh.md)

## Change

The embedded assistant previously shared the account's Workspace folders, conversations, and personal Skills across Projects. The assistant now opens these resources for the selected Project ID. History created under the older account scope is still available in standalone Harness.

## Migration

1. Preserve the existing Harness home and `ONTOLOGY_BASE_URL` when updating Harness. Keep `ONTOLOGY_USER_WORKSPACE_DIR` if this deployment stores its account directories on a separate volume.
2. In Ontology, open the assistant in a Project and create a test folder. Switch to a second Project, then return to the first and verify the folder is available again.
3. To open older account-wide conversations, use **Open in a new window** on the Ontology assistant page and sign in to standalone Harness with the same account.
