/** Browser-safe request and result vocabulary for JDCloud authentication. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'jdcloud/auth-required': { readonly reason: 'missing' | 'expired' }
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
  }
