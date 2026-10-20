# Agent Note: Web account-aware skill management

Status: implemented

English | [中文](2026-10-15-web-project-skill-management.zh.md)

## Problem

The Web composer could invoke a known skill through `/name`, but a user had to discover names indirectly and edit project files outside the product to add a skill. That excluded users who work through the graphical interface and left a browser-side file write without an explicit Session, workspace, validation, or conflict policy.

## Decision

The Web composer registers a dedicated skill button in `conversation.input.left` for ordinary Sessions. Its searchable panel reads the same `skills/list` catalog as the `/` trigger, and choosing an entry inserts the existing literal `/name` text. The picker does not introduce a second invocation protocol or send skill bodies through the draft.

The panel’s manager imports one complete local folder rooted by `SKILL.md`. The Session-addressed `skills/create` Remote owns validation and persistence. It validates the frontmatter needed for discovery, requires the skill to remain user-invocable, bounds the folder to 128 files, 5 MiB per file, 20 MiB total, and 256 KiB of UTF-8 `SKILL.md` content, rejects unsafe or duplicate relative paths, checks Session ownership and containment, and writes through an explicit filesystem execution policy.

An account-aware authentication controller exposes a personal install target under the authenticated user’s hashed workspace and an administrator-only managed target shared across users. A composition without that adapter retains project installation under the nearest ancestor of the Session cwd containing `.git`, or under the cwd when no marker exists. Installation uses guarded creation and never replaces an existing directory. `skills/list` returns the authorized targets with metadata rather than instruction bodies, and a successful install updates only the current Session’s in-memory catalog snapshot so the new entry is immediately selectable.

## Alternatives considered

**Store user-created skills in a database.** Rejected because the existing skill provider discovers project files, and project-local files remain inspectable, versionable, and portable with the code that uses them. A database would require a second provider and synchronization policy without improving the first supported workflow.

**Let the browser write the project file directly.** Rejected because the Host must enforce Session ownership, canonical path containment, filesystem policy, size limits, validation, and create-only conflict handling at the trusted write boundary.

**Introduce a structured skill reference in the composer.** Rejected because `/name` is already the cross-client invocation representation. Reusing it keeps manual entry, `/` suggestions, and the new picker behavior identical.

**Import a ZIP archive.** Rejected because archive extraction adds another path traversal and partial-write mechanism. Browser folder selection supplies the complete relative file tree directly, including `references/`, `scripts/`, `assets/`, templates, and binary files.

## Consequences

Non-developer users can discover, import, and invoke skills without leaving the Web interface. Each authenticated user can maintain private skills across that user’s projects, administrators can maintain built-in skills for every user, and compositions without account-level identity retain project-local management. The Host has one auditable write path, and same-name imports are safe.

The manager does not accept archives or a standalone `SKILL.md`; users select one complete local folder. An imported skill may become visible only after the provider observes the new directory in environments where its live registry does not watch that root; the picker’s current Session cache is updated immediately, while normal provider discovery remains authoritative after reload.
