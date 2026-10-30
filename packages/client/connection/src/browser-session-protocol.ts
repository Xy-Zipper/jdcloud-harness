/** Browser-session transport values and private same-origin bootstrap routes. */

/** Browser identity carrier selected by the deployment. */
export type BrowserSessionTransport = 'cookie' | 'bearer'

/** Same-origin route that mints one browser Bearer session. */
export const BROWSER_SESSION_BOOTSTRAP_PATH = '/api/browser-session'

/** Same-origin route that exchanges a browser Bearer session for one WebSocket ticket. */
export const BROWSER_SESSION_WEBSOCKET_TICKET_PATH = '/api/browser-session/websocket-ticket'

/** Same-origin route that authorizes one browser-managed download request. */
export const BROWSER_SESSION_DOWNLOAD_TICKET_PATH = '/api/browser-session/download-ticket'

/** Query field carrying one short-lived download ticket. */
export const BROWSER_SESSION_DOWNLOAD_TICKET_QUERY = 'downloadTicket'

/** Session-storage key scoped to one browser tab and Harness origin. */
export const BROWSER_SESSION_STORAGE_KEY = 'dsh.browser-session'
