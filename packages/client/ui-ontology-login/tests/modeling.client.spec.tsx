// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ModelingConversation } from '../src/client/ModelingConversation.tsx'
import { installModelingConversation } from '../src/client/modeling.ts'
import { NS, zh, en, type OntologyLoginKey } from '../src/client/locales.ts'

afterEach(cleanup)

describe('embedded modeling conversation', () => {
  it('shows conversation history without blank duplicates and a distinct create action', () => {
    const sessions = {
      ids: ['current', 'unused', 'history', 'other', 'archived'],
      byId: {
        current: { blank: true, displayTitle: 'opaque-directory', retainedBy: { mainView: 1 } },
        unused: { blank: true, displayTitle: 'Another blank', retainedBy: {} },
        history: { blank: false, displayTitle: '产品建模', retainedBy: {} },
        other: { blank: false, displayTitle: 'Other project', retainedBy: {} },
        archived: { blank: false, displayTitle: 'Archived', retainedBy: {} },
      },
    }
    render(<ModelingConversation {...({
      context: { projectId: 'project-1', projectName: '当前项目', mode: 'modeling' },
      newSession: vi.fn(), openSession: vi.fn(), retry: vi.fn(),
      useModeling: (select: (value: object) => object) => select({
        loading: false, error: null, workspaceId: 'workspace-1',
      }),
      useSessions: (select: (value: object) => object) => select(sessions),
      useWorkspaces: (select: (value: object) => object) => select({
        items: [{ workspaceId: 'workspace-1', sessionIds: ['current', 'unused', 'history', 'archived'] }],
        archivedSessionIds: ['archived'],
      }),
      renderSlot: () => <div data-testid="native-conversation" />,
      t: (key: OntologyLoginKey) => zh[key],
    } as Parameters<typeof ModelingConversation>[0])} />)
    expect(screen.getByText('当前项目')).toBeDefined()
    expect(screen.getAllByRole('option').map(option => option.textContent?.trim())).toEqual(['历史会话', '产品建模'])
    expect(screen.getByRole('button', { name: '新建会话' })).toBeDefined()
    expect(screen.queryByText('Other project')).toBeNull()
    expect(screen.queryByText('Archived')).toBeNull()
    expect(screen.getByTestId('native-conversation')).toBeDefined()
  })

  it('notifies the exact parent only after a new committed modeling tool succeeds and removes its listener', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.locale.register(NS, { zh, en })
    const feed = new MutableSessionEventSource()
    const workspace = { workspaceId: 'workspace-1', path: '/private/project', sessionIds: ['session-1'] }
    ctx.provide('workspaces', {
      create: () => Promise.resolve(workspace),
      list: { getSnapshot: () => ({ items: [workspace], archivedSessionIds: [] }) },
    } as never)
    ctx.provide('sessions', {
      list: {
        getSnapshot: () => ({
          ids: ['session-1'], byId: { 'session-1': { retainedBy: { mainView: 1 } } },
        }),
        subscribe: () => () => {},
      },
      binding: () => ({ eventSource: feed }),
      refresh: () => Promise.resolve(),
    } as never)
    ctx.provide('uiWorkspace', {
      listDirectory: () => Promise.resolve({ path: '/private/project' }), openSession: vi.fn(),
    } as never)
    const post = vi.spyOn(window.parent, 'postMessage')
    const fiber = ctx.plugin({
      inject: ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace'],
      apply: (child: Context) => installModelingConversation(child, {
        projectId: 'project-1', projectName: 'Current', mode: 'modeling',
      }, 'https://admin.example.com'),
    })
    try {
      await fiber.await()
      const append = (seq: number, type: string, data: object) => {
        feed.append({ type: 'event', event: { seq, time: seq, type, data } } as never)
      }
      append(1, 'tool/call', { callId: 'failed', name: 'ontology_add_draft_resources' })
      append(2, 'tool/result', { message: { toolCallId: 'failed', isError: true } })
      append(3, 'tool/call', { callId: 'read', name: 'ontology_get_draft' })
      append(4, 'tool/result', { message: { toolCallId: 'read' } })
      expect(post).not.toHaveBeenCalled()
      append(5, 'tool/call', { callId: 'save', name: 'ontology_add_draft_resources' })
      expect(post).not.toHaveBeenCalled()
      append(6, 'tool/result', { message: { toolCallId: 'save' } })
      expect(post).toHaveBeenCalledExactlyOnceWith({
        type: 'ontology/draft-updated', version: 1, projectId: 'project-1',
      }, 'https://admin.example.com')
      append(7, 'tool/call', { callId: 'bind', name: 'ontology_update_draft_bindings' })
      append(8, 'tool/result', { message: { toolCallId: 'bind' } })
      expect(post).toHaveBeenCalledTimes(2)
      await fiber.dispose()
      append(9, 'tool/call', { callId: 'after-dispose', name: 'ontology_add_draft_resources' })
      append(10, 'tool/result', { message: { toolCallId: 'after-dispose' } })
      expect(post).toHaveBeenCalledTimes(2)
    } finally {
      post.mockRestore()
      await ctx.fiber.dispose()
    }
  })
})
