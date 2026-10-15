/** Browser-safe request and result vocabulary for Ontology Runtime authentication. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'ontology/auth-required': { readonly reason: 'missing' | 'expired' }
    'ontology/auth-failed': { readonly code: string | null; readonly status: number | null }
    'ontology/session-import-failed': { readonly code: string | null; readonly status: number | null }
    'ontology/validation-failed': { readonly code: string | null; readonly status: number | null }
    'ontology/logout-failed': { readonly code: string | null; readonly status: number | null }
    'ontology/administrator-required': { readonly capability: 'danger-full-access' }
  }
}

/** Account kinds returned by the Ontology Runtime identity API. */
export type OntologyAccountType = 'admin' | 'member'

/** Stable Ontology identity resolved from one Runtime Session. */
export interface OntologyRuntimeIdentity {
  readonly userId: string
  readonly username: string
  readonly displayName: string
  readonly accountType: OntologyAccountType
  readonly authorizationVersion: string
}

/** Password-login request sent from the browser to the Host. */
export interface OntologyLoginRequest {
  readonly username: string
  readonly password: string
}

/** Runtime tokens transferred from an authenticated Ontology management page. */
export interface OntologyRuntimeSessionTransfer {
  readonly accessToken: string
  readonly accessTokenExpiresAt: string
  readonly refreshToken: string
  readonly refreshTokenExpiresAt: string
  readonly user: OntologyRuntimeIdentity
}

/** Host-only request to one fixed Ontology Runtime endpoint. */
export interface OntologyAuthenticatedRequest {
  readonly method: 'GET' | 'POST'
  readonly path: `/api/runtime/${string}`
  readonly body?: Readonly<Record<string, unknown>>
}

/** Redacted authentication state returned to the browser. */
export type OntologyAuthStatus =
  | {
    readonly authenticated: false
    readonly baseUrl: string
  }
  | {
    readonly authenticated: true
    readonly baseUrl: string
    readonly user: OntologyRuntimeIdentity
  }
