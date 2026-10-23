/** Physical socket selection for browser, desktop, and authenticated Node connections. */

/** Socket events consumed by the Gateway on browser and Node carriers. */
export interface ConnectionWebSocketEventMap {
  readonly open: object
  readonly error: object
  readonly close: object
  readonly message: { readonly data: unknown }
}

/** Text WebSocket operations shared by the browser API and Node carriers. */
export interface ConnectionWebSocket {
  /** Standard WebSocket state, from CONNECTING (0) through CLOSED (3). */
  readonly readyState: number
  /** @param data - complete text frame to send. */
  send(data: string): void
  /**
   * @param code - protocol close code.
   * @param reason - peer-facing close explanation.
   */
  close(code?: number, reason?: string): void
  /**
   * @param event - physical socket event.
   * @param listener - callback for that event.
   * @param options - whether the callback is removed after its first delivery.
   */
  addEventListener<Event extends keyof ConnectionWebSocketEventMap>(
    event: Event,
    listener: (event: ConnectionWebSocketEventMap[Event]) => void,
    options?: { readonly once?: boolean },
  ): void
  /**
   * @param event - physical socket event.
   * @param listener - previously registered callback.
   */
  removeEventListener<Event extends keyof ConnectionWebSocketEventMap>(
    event: Event,
    listener: (event: ConnectionWebSocketEventMap[Event]) => void,
  ): void
}

/**
 * Create an authenticated socket; its consumer owns framing and closing.
 * @param url - absolute WebSocket URL beneath the selected Host mount.
 * @returns a newly connecting socket, before it emits open or failure.
 */
export type ConnectionWebSocketFactory = (url: string) => ConnectionWebSocket

/**
 * Resolve a logical channel against the explicit Host or the page's document base.
 * @param path - absolute logical channel path.
 * @param factory - authenticated socket factory; omission uses the browser API.
 * @param baseUrl - Host base URL, required outside a document.
 * @param authorize - optional asynchronous ticket exchange before opening the socket.
 * @returns a socket owned by the calling channel.
 */
export function openConnectionWebSocket(
  path: string,
  factory: ConnectionWebSocketFactory = url => new WebSocket(url),
  baseUrl?: string,
  authorize?: (url: string) => string | Promise<string>,
): ConnectionWebSocket {
  const base = baseUrl ?? (typeof document === 'undefined' ? undefined : document.baseURI)
  if (base === undefined) throw new Error('connection: WebSocket carrier requires streamBaseUrl outside a document')
  const url = new URL(path.slice(1), base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return authorize === undefined ? factory(url.href) : authorizedSocket(url.href, factory, authorize)
}

/** Preserve synchronous socket ownership while the browser obtains its upgrade ticket. */
function authorizedSocket(
  url: string,
  factory: ConnectionWebSocketFactory,
  authorize: (url: string) => string | Promise<string>,
): ConnectionWebSocket {
  const events = new EventTarget()
  let socket: ConnectionWebSocket | undefined
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    events.dispatchEvent(new Event('close'))
  }
  const failed = (): void => { events.dispatchEvent(new Event('error')) }
  const opened = (): void => { events.dispatchEvent(new Event('open')) }
  const received = (event: { readonly data: unknown }): void => {
    events.dispatchEvent(new MessageEvent('message', { data: event.data }))
  }
  const ended = (): void => {
    socket?.removeEventListener('open', opened)
    socket?.removeEventListener('error', failed)
    socket?.removeEventListener('message', received)
    socket?.removeEventListener('close', ended)
    close()
  }
  void Promise.resolve().then(() => authorize(url)).then((authorizedUrl) => {
    if (closed) return
    socket = factory(authorizedUrl)
    socket.addEventListener('open', opened)
    socket.addEventListener('error', failed)
    socket.addEventListener('message', received)
    socket.addEventListener('close', ended)
  }).catch((_error: unknown) => {
    if (closed) return
    failed()
    close()
  })
  return {
    get readyState() { return closed ? 3 : socket?.readyState ?? 0 },
    send(data) {
      if (socket === undefined || closed) throw new Error('connection: WebSocket is not open')
      socket.send(data)
    },
    close(code, reason) {
      if (socket !== undefined) socket.close(code, reason)
      else if (!closed) {
        closed = true
        queueMicrotask(() => { events.dispatchEvent(new Event('close')) })
      }
    },
    addEventListener(event, listener, options) {
      events.addEventListener(event, listener as EventListener, options)
    },
    removeEventListener(event, listener) {
      events.removeEventListener(event, listener as EventListener)
    },
  }
}
