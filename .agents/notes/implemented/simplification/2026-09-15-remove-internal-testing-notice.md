# Agent Note: Remove the internal-testing notice

Status: implemented

English | [中文](2026-09-15-remove-internal-testing-notice.zh.md)

## Problem

The Web client blocked every fresh browser profile with a versioned internal-testing notice before it could show the useful DeepSeek credential setup. The statement described the product as a developer test and required acknowledgement even in deployments that already provide their own login and release context.

## Decision

The Web client does not register or render the internal-testing notice. The Settings shell continues to coordinate contributed onboarding steps in order; the later removal of the DeepSeek credential step belongs to [server-managed models for remote Web deployments](../bug-fix/2026-09-15-server-managed-models-for-remote-web.md).

The removed notice has no acknowledgement store or locale copy. The Host entry of `ui-settings-general` is inert because no remaining feature reads `ui-onboarding.welcomeNoticeVersion`; existing settings documents may retain that unknown field without compatibility behavior.

Browser coverage verifies that the application opens without the notice. The remote-only welcome scenario and welcome golden are absent, while the preview boot and stress lanes no longer dismiss or hide the notice.

## Alternatives considered

**Disable the notice only in the JDCloud Docker overlay.** Rejected because the internal-testing statement is not useful product behavior in other release deployments, and a deployment-only switch would retain the component, persistence field, translations, and tests solely to hide them here.

**Keep the acknowledgement field for compatibility.** Rejected because no current consumer reads it, and user settings tolerate an existing unknown section without a migration or fallback path.

**Replace the statement with a shorter welcome message.** Rejected because the request is to remove the mandatory declaration, and release deployments already provide their own entry context.

## Consequences

Fresh users reach the JDCloud login or application without acknowledging product-stage copy. The codebase loses the notice component, state controller, durable settings namespace, locale strings, dedicated remote behavior, and their tests. The generic onboarding ledger remains available for feature-owned flows, but restoring a product announcement requires a new current need, copy owner, completion policy, and browser coverage.
