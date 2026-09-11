/** Browser-safe request and result vocabulary for JDCloud authentication. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'jdcloud/auth-required': { readonly reason: 'missing' | 'expired' }
    'jdcloud/administrator-required': { readonly capability: 'model-selection' }
    'jdcloud/auth-failed': { readonly code: number | null }
    'jdcloud/switch-failed': { readonly code: number | null }
    'jdcloud/validation-failed': { readonly code: number | null }
  }
}

/** One tenant available to the authenticated JDCloud account. */
export interface JdcloudCorp {
  readonly corpId: string
  readonly corpName: string
}

/** Password-login request; the Host hashes the password and never stores it. */
export interface JdcloudLoginRequest {
  readonly baseUrl: string
  readonly username: string
  readonly password: string
}

/** Token-transfer login request received from the JDCloud entry page. */
export interface JdcloudTokenLoginRequest {
  readonly baseUrl: string
  readonly token: string
}

/** One Host-only JDCloud API request that reuses the stored login. */
export interface JdcloudAuthenticatedRequest {
  readonly path: `/api/${string}`
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly body?: unknown
}

/** JDCloud low-code menu kinds exposed by the write-action picker. */
export type JdcloudLowcodeMenuType = 3 | 4

/** JDCloud data mutations the Host authorizes for one low-code menu. */
export type JdcloudLowcodeWritePermission = 'addData' | 'editData' | 'deleteData'

/** One form or workflow with at least one Host-confirmed data mutation grant. */
export interface JdcloudWritableMenu {
  readonly menuId: string
  readonly fullName: string
  readonly path: string
  readonly type: JdcloudLowcodeMenuType
  readonly agentPermissions: readonly JdcloudLowcodeWritePermission[]
}

/** Current-tenant writable menus returned to the authenticated browser. */
export interface JdcloudWritableMenuState {
  readonly corpId: string
  readonly menus: readonly JdcloudWritableMenu[]
}

/** Host projection of the current tenant's low-code authorization facts. */
export interface JdcloudLowcodeCapabilityState {
  readonly systemAdministrator: boolean
  readonly menus: readonly JdcloudWritableMenu[]
}

/** Redacted authentication state returned to the browser. */
export type JdcloudAuthStatus =
  | {
    readonly authenticated: false
    readonly baseUrl: string
  }
  | {
    readonly authenticated: true
    readonly baseUrl: string
    readonly username: string
    readonly corpId: string
    readonly corpName: string
    readonly corps: readonly JdcloudCorp[]
    readonly systemAdministrator: boolean
  }
