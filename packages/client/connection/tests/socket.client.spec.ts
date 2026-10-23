/** Physical WebSocket selection and Host mount resolution. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openConnectionWebSocket,
  type ConnectionWebSocket,
  type ConnectionWebSocketFactory,
} from '../src/client/socket.ts'

function socketProbe(): ConnectionWebSocket {
  return {
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Connection WebSocket carrier', () => {
  it('authorizes each socket URL before creating its physical carrier', async () => {
    const socket = Object.assign(new EventTarget(), {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn(),
    })
    const removed = vi.spyOn(socket, 'removeEventListener')
    const factory = vi.fn<ConnectionWebSocketFactory>(() => ({
      get readyState() { return socket.readyState },
      send: socket.send,
      close: socket.close,
      addEventListener: (event, listener, options) => {
        socket.addEventListener(event, listener as EventListener, options)
      },
      removeEventListener: (event, listener) => {
        socket.removeEventListener(event, listener as EventListener)
      },
    }))
    const ticket = Promise.withResolvers<string>()
    const authorize = vi.fn(() => ticket.promise)
    const candidate = openConnectionWebSocket('/api/remote.mux', factory, 'https://host.example/', authorize)
    expect(candidate.readyState).toBe(0)
    await Promise.resolve()
    expect(authorize).toHaveBeenCalledExactlyOnceWith('wss://host.example/api/remote.mux')
    expect(factory).not.toHaveBeenCalled()
    ticket.resolve('wss://host.example/api/remote.mux?ticket=one-use')
    await vi.waitFor(() => {
      expect(factory).toHaveBeenCalledExactlyOnceWith('wss://host.example/api/remote.mux?ticket=one-use')
    })
    const opened = vi.fn()
    const message = vi.fn()
    const closed = vi.fn()
    candidate.addEventListener('open', opened, { once: true })
    candidate.addEventListener('message', message)
    candidate.addEventListener('close', closed)
    socket.readyState = 1
    socket.dispatchEvent(new Event('open'))
    socket.dispatchEvent(new Event('open'))
    socket.dispatchEvent(new MessageEvent('message', { data: 'gateway-ready' }))
    expect(candidate.readyState).toBe(1)
    expect(opened).toHaveBeenCalledOnce()
    expect(message).toHaveBeenCalledWith(expect.objectContaining({ data: 'gateway-ready' }))
    candidate.send('request')
    expect(socket.send).toHaveBeenCalledExactlyOnceWith('request')
    candidate.removeEventListener('message', message)
    socket.dispatchEvent(new MessageEvent('message', { data: 'ignored' }))
    expect(message).toHaveBeenCalledOnce()
    candidate.close()
    expect(socket.close).toHaveBeenCalledOnce()
    socket.dispatchEvent(new Event('close'))
    expect(closed).toHaveBeenCalledOnce()
    expect(candidate.readyState).toBe(3)
    expect(removed).toHaveBeenCalledTimes(4)
  })

  it('closes a pending authorization without opening a late socket', async () => {
    const factory = vi.fn<ConnectionWebSocketFactory>()
    const ticket = Promise.withResolvers<string>()
    const candidate = openConnectionWebSocket('/api/remote.mux', factory, 'https://host.example/', () => ticket.promise)
    const closed = vi.fn()
    candidate.addEventListener('close', closed)
    candidate.close()
    ticket.resolve('wss://host.example/api/remote.mux?ticket=late')
    await vi.waitFor(() => { expect(closed).toHaveBeenCalledOnce() })
    expect(candidate.readyState).toBe(3)
    expect(factory).not.toHaveBeenCalled()
  })

  it('reports authorization failure through socket error and close events', async () => {
    const candidate = openConnectionWebSocket('/api/remote.mux', socketProbe, 'https://host.example/',
      () => Promise.reject(new Error('ticket refused')))
    const failed = vi.fn()
    const closed = vi.fn()
    candidate.addEventListener('error', failed)
    candidate.addEventListener('close', closed)
    await vi.waitFor(() => { expect(closed).toHaveBeenCalledOnce() })
    expect(failed).toHaveBeenCalledOnce()
    expect(candidate.readyState).toBe(3)
  })

  it('requires an explicit Host base outside a document before opening a socket', () => {
    const factory = vi.fn<ConnectionWebSocketFactory>()

    expect(typeof document).toBe('undefined')
    expect(() => openConnectionWebSocket('/api/remote.mux', factory))
      .toThrow('connection: WebSocket carrier requires streamBaseUrl outside a document')
    expect(factory).not.toHaveBeenCalled()
  })

  it.each([
    ['http://host.example/tools/dsh/', 'ws://host.example/tools/dsh/api/remote.mux'],
    ['https://host.example/tools/dsh/', 'wss://host.example/tools/dsh/api/remote.mux'],
  ])('resolves the channel beneath the explicit Host base %s', (base, expected) => {
    const socket = socketProbe()
    const factory = vi.fn<ConnectionWebSocketFactory>().mockReturnValue(socket)

    expect(openConnectionWebSocket('/api/remote.mux', factory, base)).toBe(socket)
    expect(factory).toHaveBeenCalledExactlyOnceWith(expected)
  })

  it('uses the browser WebSocket and document base when no carrier is supplied', () => {
    const socket = socketProbe()
    const browserSocket = vi.fn(function (_url: string) { return socket })
    vi.stubGlobal('document', { baseURI: 'https://browser.example/mounted/' } satisfies Pick<Document, 'baseURI'>)
    vi.stubGlobal('WebSocket', browserSocket)
    try {
      expect(openConnectionWebSocket('/api/remote.mux')).toBe(socket)
      expect(browserSocket).toHaveBeenCalledExactlyOnceWith('wss://browser.example/mounted/api/remote.mux')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
