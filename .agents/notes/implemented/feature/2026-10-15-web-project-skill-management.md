# Agent Note: Web project-local skill management

Status: implemented

English | [中文](2026-10-15-web-project-skill-management.zh.md)

## Problem

The Web composer could invoke a known skill through `/name`, but a user had to discover names indirectly and edit project files outside the product to add a skill. That excluded users who work through the graphical interface and left a browser-side file write without an explicit Session, workspace, validation, or conflict policy.

## Decision

The Web composer registers a dedicated skill button in `conversation.input.left` for ordinary Sessions. Its searchable panel reads the same `skills/list` catalog as the `/` trigger, and choosing an entry inserts the existing literal `/name` text. The picker does not introduce a second invocation protocol or send skill bodies through the draft.

The panel’s manager creates a `SKILL.md` from guided fields or imports one complete `SKILL.md`. The Session-addressed `skills/create` Remote owns validation and persistence. It validates the frontmatter needed for discovery, requires the skill to remain user-invocable, limits the document to 256 KiB of UTF-8 content, checks Ontology Session ownership and workspace containment when that controller is present, and writes through the filesystem’s `workspace-write` policy.

An installed skill lives at `.dsh/skills/<name>/SKILL.md` under the nearest ancestor of the Session cwd containing `.git`; when no such marker exists, the Session cwd is the project root. Installation uses guarded creation and never replaces an existing file. The catalog continues to expose metadata rather than instruction bodies, and a successful install updates only the current Session’s in-memory catalog snapshot so the new entry is immediately selectable.

## Alternatives considered

**Store user-created skills in a database.** Rejected because the existing skill provider discovers project files, and project-local files remain inspectable, versionable, and portable with the code that uses them. A database would require a second provider and synchronization policy without improving the first supported workflow.

**Let the browser write the project file directly.** Rejected because the Host must enforce Session ownership, canonical path containment, filesystem policy, size limits, validation, and create-only conflict handling at the trusted write boundary.

**Introduce a structured skill reference in the composer.** Rejected because `/name` is already the cross-client invocation representation. Reusing it keeps manual entry, `/` suggestions, and the new picker behavior identical.

**Import a ZIP bundle with companion files.** Rejected for the first supported manager because archive extraction adds path traversal, collision, and partial-write decisions. Companion `references/`, `scripts/`, `assets/`, and template files remain an external project-file workflow.

## Consequences

Non-developer users can discover, create, import, and invoke project skills without leaving the Web interface. The Host has one auditable write path, same-name imports are safe, and installed skills remain ordinary project files consumed by the existing provider.

The manager cannot install multi-file skills. A created or imported skill may become visible only after the provider observes the new file in environments where its live registry does not watch project changes; the picker’s current Session cache is updated immediately, while normal provider discovery remains authoritative after reload.
