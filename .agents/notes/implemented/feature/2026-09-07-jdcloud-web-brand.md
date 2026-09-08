# Agent Note: JDCloud Web brand overlay

Status: implemented

English | [中文](2026-09-07-jdcloud-web-brand.zh.md)

## Problem

The JDCloud authentication layer still exposed the DeepSeek fish, generic local-build name, browser title, and favicon after login. Replacing package names, npm scope, CLI commands, or internal product identity would increase divergence from upstream without improving the low-code user's browser experience.

## Decision

The JDCloud login Client plugin owns one blue-to-cyan hexagonal J mark and the `JDCloud Harness` display name. It registers the mark in `sidebar.brand.mark` and `conversation.hero.brand.mark`, registers the name in `sidebar.brand.name`, and reuses the mark on the login page. Each single-slot registration uses priority `-10`, so it shadows the generic or official occupant while the JDCloud plugin is active and reveals the previous occupant when the plugin is removed.

The Web shell defaults its document title, localized local-build name, PWA name, short name, and SVG favicon to JDCloud Harness. Session titles retain the existing `<session> — <product>` projection. The favicon uses the same geometry as the React mark and adjusts its blue-cyan palette for dark color schemes.

Package names, the `@deepseek-ai` npm scope, `dsh` commands, build-environment variable names, repository metadata, and model-visible DeepSeek Harness identity remain unchanged. The official build profile also retains its explicit DeepSeek Harness title; this fork's default Web resources and optional JDCloud bundle provide the company-facing brand.

## Alternatives considered

**Rename every package and internal identity.** Rejected because browser branding does not require a repository-wide fork of package resolution, commands, durable paths, prompts, or upstream documentation.

**Replace the shared FishLogo primitive.** Rejected because that primitive is the generic and official fallback; changing it would couple JDCloud artwork to every consumer and make upstream merges harder.

**Create a separate branding package.** Rejected because the login bundle is already the deployment boundary for JDCloud users. Adding another package and bundle row would add installation and lifecycle complexity without independent reuse.

## Consequences

Installing the JDCloud login bundle changes the login page, expanded and collapsed sidebar marks, blank-conversation mark, and sidebar name as one lifecycle. Removing the bundle restores the underlying slot occupants, while the Web shell's static title and PWA resources remain JDCloud defaults for this fork.

The SVG mark has two maintained forms: the React component used by plugin slots and the static favicon used before Client plugins load. Tests pin their shared identifying geometry, requested sizes, slot priorities, lifecycle disposal, title fallback, and PWA metadata.
