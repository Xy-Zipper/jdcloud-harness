---
description: "JDCloud login, account controls, and JDCloud Harness branding for the Web client."
kind: "package-reference"
---

# JDCloud Login UI

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-ui-jdcloud-login` presents the JDCloud login page while the Host has no stored login, an account summary while it is authenticated, and the JDCloud Harness brand across the Web shell. It mounts the generated JDCloud Remote contribution itself, so the general API Remote assembly stays independent of this optional integration.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Install it through the [`dsh-jdcloud-login`](../../bundle/jdcloud-login/README.md) bundle. The page asks for a service address, account, and password. The initial service address comes from the Host controller's redacted status, which the bundle can seed through `JDCLOUD_DEFAULT_BASE_URL`.

The page occupies `root` at priority `-100`. A successful login removes that contribution and reveals the already-mounted application without replacing Session state. When the Host deletes the JDCloud credential record after a `600`, `601`, or `602` validation response, the forwarded `credentials/record-updated` event restores the login page. The rejected conversation draft remains Client state and is not automatically submitted after another login.

While authenticated, the package occupies `sidebar.account`. The expanded sidebar shows the account and current tenant returned by the Host; the collapsed rail shows only the account icon. The account menu lists all available owned and joined tenants, marks the current tenant, and switches to another tenant without showing the login page. Tenant rows scroll within a 240-pixel region while Sign out stays pinned. A failed switch preserves the current tenant and reports the error in the menu. Selecting Sign out deletes the Host credential and restores the login page.

The package also fills `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` at priority `-10`. The blue-to-cyan hexagonal J mark keeps the size requested by each host, and the login page reuses the same artwork. Lower priority wins for these single slots, so the JDCloud occupants replace generic or official brand entries while this plugin is active and reveal them again on teardown.

The password stays in component-local state, is cleared after success, and never enters a shared store. All product copy is owned by the `jdcloud.login` locale namespace.

<a id="model-experience"></a>
## Model Experience

None, as this package controls browser presentation and calls Host authentication methods only.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The page supports service-address plus account/password login only.
- It does not automatically retry a prompt rejected by authentication validation.

<a id="dev-note"></a>
### Dev Note

None.

**Runtime invariant:** No companion is published. The generated Remote mount, root login contribution, sidebar account contribution, and brand occupants share one plugin lifecycle and are removed together.
