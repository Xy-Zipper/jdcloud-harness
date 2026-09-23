/** Independent browser identity used by deployments that do not use Harness launch authentication. */
import { type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest } from './rpc.ts'
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Request-local independent browser session, when enabled by the deployment. */
    browserSession?: BrowserSessionService
  }
}
/** Carries one opaque browser id through HTTP, RPC, and Fetch handlers. */
export declare class BrowserSessionService extends Service {
  private readonly secret
  private readonly maxAgeMilliseconds
  static inject: string[]
  private readonly requests
  private constructor()
  /**
     * Create the durable cookie-signing owner.
     * @param ctx - Context that owns the service.
     * @param credentials - Credential store for the signing secret.
     * @param maxAgeDays - Cookie lifetime in days.
     * @returns The initialized browser-session service.
     */
  static create(ctx: Context, credentials: CredentialProvider, maxAgeDays?: number): Promise<BrowserSessionService>
  /**
     * Mint one browser cookie before the first index response.
     * @param request - Incoming connection index request.
     * @param response - Response writer used for the redirect and cookie.
     * @returns Whether the request already has a valid browser session.
     */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean
  /**
     * Return whether the request has a valid browser cookie.
     * @param request - Incoming connection trust request.
     * @returns Whether the request carries a valid browser session.
     */
  accepts(request: ConnectionTrustRequest): boolean
  /**
     * Run one request with its browser id available to Host services.
     * @param request - Incoming connection trust request.
     * @param operation - Operation that reads the request-local browser id.
     * @returns The operation result.
     */
  run<Value>(request: ConnectionTrustRequest, operation: () => Value): Value
  /**
     * Read the current browser id inside a request handler.
     * @returns The current opaque browser id.
     */
  currentIdRequired(): string
  private browserId
}
//# sourceMappingURL=browser-session.d.ts.map
