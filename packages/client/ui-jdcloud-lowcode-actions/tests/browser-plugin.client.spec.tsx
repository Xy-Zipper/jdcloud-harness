// @vitest-environment jsdom
/** Real client-plugin registration and card interaction coverage. */

import { Context } from '@deepseek-ai/cordis'
import type { JdcloudWritableMenu } from '@deepseek-ai/dsh-api-jdcloud-auth-controller/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { InputTriggerSource, ReferenceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { LowcodeActionPicker } from '../src/client/LowcodeActionPicker.tsx'
import { zh } from '../src/client/locales.ts'
import type { WritableMenuPickerInjected, WritableMenuState } from '../src/client/types.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const MENUS: readonly JdcloudWritableMenu[] = [
  {
    menuId: 'leave',
    fullName: '请假申请',
    path: '人事管理 / 请假申请',
    type: 4,
    agentPermissions: ['addData'],
  },
  {
    menuId: 'attendance',
    fullName: '打卡记录',
    path: '考勤 / 打卡记录',
    type: 3,
    agentPermissions: ['editData', 'deleteData'],
  },
]

/** Assemble the plugin over controllable Remote and input-source faces. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.input.dock': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const writableMenus = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: { corpId: 'corp-current', menus: MENUS },
  }))
  let credentialListener: ((key: string) => void) | undefined
  ctx.provide('remote', {
    jdcloudAuth: { writableMenus },
    $on: vi.fn((event: string, listener: (key: string) => void) => {
      if (event === 'credentials/record-updated') credentialListener = listener
      return () => {
        if (event === 'credentials/record-updated') credentialListener = undefined
      }
    }),
  } as never)
  ctx.provide('remote.jdcloudAuth', { writableMenus } as never)
  let source: InputTriggerSource | undefined
  ctx.provide('inputTriggers', {
    registerSource(next: InputTriggerSource) {
      source = next
      return () => { source = undefined }
    },
  } as never)
  ctx.provide('sessions', {
    scope: () => ctx,
  } as never)
  let inserted: { reference: ReferenceInsert; draftRev: number } | undefined
  ctx.on('slash/input-insert-reference', (request) => {
    inserted = { reference: request.reference, draftRev: request.span.draftRev }
    return true
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  await vi.waitFor(() => { expect(writableMenus).toHaveBeenCalledOnce() })
  const entry = ctx.slots.entries('conversation.input.dock')[0]
  if (entry === undefined) throw new Error('writable-menu dock did not register')
  const injected = (entry.inject as unknown as ((sessionId: SessionId) => WritableMenuPickerInjected))(
    'session-1' as SessionId,
  )
  await vi.waitFor(() => { expect(writableMenus).toHaveBeenCalledTimes(2) })
  expect(injected.hooks.writableMenus.getSnapshot().phase).toBe('ready')
  return {
    ctx,
    fiber,
    writableMenus,
    injected,
    source: () => source,
    inserted: () => inserted,
    emitCredential: (key: string) => { credentialListener?.(key) },
  }
}

describe('JDCloud low-code action browser plugin', () => {
  it('registers the single-select dock and inserts a structured tag at the draft start', async () => {
    const b = await bench()
    expect(inject).toEqual([
      'inputTriggers', 'sessions', 'slots', 'locale', 'remote', 'remote.jdcloudAuth',
    ])
    expect(b.source()).toMatchObject({ trigger: '@', name: 'jdcloud-lowcode-function' })
    b.injected.selectMenu(MENUS[0]!, 7)
    expect(b.inserted()).toMatchObject({
      draftRev: 7,
      reference: {
        source: 'jdcloud-lowcode-function',
        label: '请假申请',
        clipboardText: '@请假申请',
      },
    })
    await b.fiber.dispose()
    expect(b.source()).toBeUndefined()
  })

  it('revalidates the selected menu before serializing model-visible context', async () => {
    const b = await bench()
    b.injected.selectMenu(MENUS[0]!, 1)
    const reference = b.inserted()?.reference
    if (reference === undefined) throw new Error('selection did not insert a reference')
    await expect(b.source()?.codec?.serialize(reference.ref, AbortSignal.timeout(1000)))
      .resolves.toContain(JSON.stringify({
        menuId: 'leave',
        fullName: '请假申请',
        path: '人事管理 / 请假申请',
        type: 'workflow',
        agentPermissions: ['addData'],
      }))
    expect(b.writableMenus).toHaveBeenCalledTimes(3)

    b.writableMenus.mockResolvedValueOnce({
      ok: true,
      value: { corpId: 'corp-next', menus: MENUS },
    })
    await expect(b.source()?.codec?.serialize(reference.ref, AbortSignal.timeout(1000)))
      .rejects.toThrow('unavailable in the current tenant')
    await b.fiber.dispose()
  })

  it('refreshes the menu projection after JDCloud credential changes', async () => {
    const b = await bench()
    b.emitCredential('another-plugin/login')
    await Promise.resolve()
    expect(b.writableMenus).toHaveBeenCalledTimes(2)
    b.emitCredential('jdcloud-auth-controller/login')
    await vi.waitFor(() => { expect(b.writableMenus).toHaveBeenCalledTimes(3) })
    await b.fiber.dispose()
  })
})

describe('LowcodeActionPicker', () => {
  const t = makeTranslate(zh, commonZh)
  const session = {
    blank: true,
    promptAttempted: false,
    subagent: null,
  }
  const input = {
    draftRev: 4,
    occurrences: [],
  }

  it('hides immediately after selection and returns when the tag is removed', () => {
    const store = createSnapshotStore<WritableMenuState>({
      phase: 'ready', corpId: 'corp-current', menus: MENUS,
    })
    const selectMenu = vi.fn(() => true)
    const props = {
      sessionId: 'session-1' as SessionId,
      session,
      input,
      useWritableMenus: (selector: (state: WritableMenuState) => unknown) => selector(store.getSnapshot()),
      selectMenu,
      t,
    } as unknown as Parameters<typeof LowcodeActionPicker>[0]
    const view = render(<LowcodeActionPicker {...props} />)
    fireEvent.click(view.getByRole('button', { name: /请假申请/ }))
    expect(selectMenu).toHaveBeenCalledWith(MENUS[0], 4)
    expect(view.queryByLabelText('可用的低代码功能')).toBeNull()

    view.rerender(<LowcodeActionPicker {...{
      ...props,
      input: { ...input, occurrences: [{ source: 'jdcloud-lowcode-function' }] },
    } as Parameters<typeof LowcodeActionPicker>[0]} />)
    expect(view.queryByLabelText('可用的低代码功能')).toBeNull()

    view.rerender(<LowcodeActionPicker {...props} />)
    expect(view.getByLabelText('可用的低代码功能')).toBeTruthy()
  })

  it('does not render for an active Session or an empty writable-menu list', () => {
    const readyEmpty = createSnapshotStore<WritableMenuState>({
      phase: 'ready', corpId: 'corp-current', menus: [],
    })
    const base = {
      sessionId: 'session-1' as SessionId,
      session,
      input,
      selectMenu: vi.fn(() => true),
      t,
    }
    const active = render(<LowcodeActionPicker {...{
      ...base,
      session: { ...session, promptAttempted: true },
      useWritableMenus: (selector: (state: WritableMenuState) => unknown) => selector({
        phase: 'ready', corpId: 'corp-current', menus: MENUS,
      }),
    } as unknown as Parameters<typeof LowcodeActionPicker>[0]} />)
    expect(active.container.firstChild).toBeNull()
    cleanup()
    const empty = render(<LowcodeActionPicker {...{
      ...base,
      useWritableMenus: (selector: (state: WritableMenuState) => unknown) => selector(readyEmpty.getSnapshot()),
    } as unknown as Parameters<typeof LowcodeActionPicker>[0]} />)
    expect(empty.container.firstChild).toBeNull()
  })
})

describe('JDCloud low-code action node half', () => {
  it('stays inert in the Host Loader', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
