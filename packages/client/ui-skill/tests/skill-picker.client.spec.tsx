// @vitest-environment jsdom
/** Visual skill discovery and current-workspace installation behavior. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  SkillPickerView,
  type SkillInstallOutcome,
  type SkillPickerViewProps,
} from '../src/client/SkillPicker.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: SkillPickerViewProps['t'] = makeTranslate(zh)

function actions(
  insertText = vi.fn(() => true),
  captureInsertion = vi.fn(() => ({ start: 2, end: 2, draftRev: 4 })),
): InputActions {
  return {
    captureInsertion,
    insertText,
    setDraft: vi.fn(),
    addAttachments: vi.fn(() => true),
    removeAttachment: vi.fn(),
    pruneAttachments: vi.fn(),
    submit: vi.fn(),
  }
}

const catalog = [
  { name: 'code-review', description: '检查当前代码改动', modelInvocable: true },
  { name: 'order-helper', description: '协助处理销售订单', modelInvocable: false },
]

function setup(options: {
  readonly available?: boolean
  readonly inputActions?: InputActions
  readonly installSkill?: (content: string) => Promise<SkillInstallOutcome>
  readonly loadCatalog?: () => Promise<typeof catalog>
} = {}) {
  const inputActions = options.inputActions ?? actions()
  const installSkill = options.installSkill ?? vi.fn(async (content: string): Promise<SkillInstallOutcome> => ({
    ok: true as const,
    skill: {
      name: content.includes('name: imported-skill') ? 'imported-skill' : 'workspace-helper',
      description: '自定义技能',
      modelInvocable: true,
    },
  }))
  const loadCatalog = options.loadCatalog ?? vi.fn(() => Promise.resolve(catalog))
  const view = render(<SkillPickerView
    available={options.available ?? true}
    inputActions={inputActions}
    installSkill={installSkill}
    loadCatalog={loadCatalog}
    t={t}
  />)
  return { inputActions, installSkill, loadCatalog, view }
}

function openPicker(): void {
  fireEvent.click(screen.getByRole('button', { name: '选择技能' }))
}

async function openManager(): Promise<void> {
  openPicker()
  fireEvent.click(await screen.findByRole('button', { name: '管理技能' }))
  await screen.findByRole('dialog', { name: '技能管理' })
}

describe('SkillPickerView', () => {
  it('hides the composer control for addressed subagent sessions', () => {
    const { view } = setup({ available: false })
    expect(view.container.innerHTML).toBe('')
  })

  it('loads, searches, and inserts a selected skill at the captured caret', async () => {
    const insertText = vi.fn(() => true)
    const captureInsertion = vi.fn(() => ({ start: 2, end: 2, draftRev: 4 }))
    const inputActions = actions(insertText, captureInsertion)
    const { loadCatalog } = setup({ inputActions })
    openPicker()

    expect(await screen.findByRole('option', { name: /code-review/ })).toBeDefined()
    expect(loadCatalog).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索技能' }), { target: { value: '订单' } })
    expect(screen.queryByRole('option', { name: /code-review/ })).toBeNull()
    const order = screen.getByRole('option', { name: /order-helper/ })
    expect(order.textContent).toContain('仅用户')
    fireEvent.click(order)

    expect(captureInsertion).toHaveBeenCalledOnce()
    expect(insertText).toHaveBeenCalledWith('/order-helper ', {
      start: 2, end: 2, draftRev: 4,
    })
    expect(screen.queryByRole('dialog', { name: '技能' })).toBeNull()
  })

  it('reports an insertion conflict without discarding the open catalog', async () => {
    const inputActions = actions(vi.fn(() => false))
    setup({ inputActions })
    openPicker()
    fireEvent.click(await screen.findByRole('option', { name: /code-review/ }))

    expect(screen.getByRole('alert').textContent).toBe('输入内容已变化，请重新选择技能')
    expect(screen.getByRole('dialog', { name: '技能' })).toBeDefined()
  })

  it('creates a workspace skill from the guided form', async () => {
    const installSkill = vi.fn(async (): Promise<SkillInstallOutcome> => ({
      ok: true,
      skill: { name: 'workspace-helper', description: '处理工作区订单', modelInvocable: true },
    }))
    setup({ installSkill })
    await openManager()

    fireEvent.change(screen.getByLabelText('技能名称'), { target: { value: 'workspace-helper' } })
    fireEvent.change(screen.getByLabelText('功能说明'), { target: { value: '处理工作区订单' } })
    fireEvent.change(screen.getByLabelText('技能指令'), { target: { value: '先检查订单，再输出异常。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }))

    await waitFor(() => {
      expect(installSkill).toHaveBeenCalledWith([
        '---',
        'name: workspace-helper',
        'description: "处理工作区订单"',
        '---',
        '',
        '先检查订单，再输出异常。',
        '',
      ].join('\n'))
    })
    expect(screen.queryByRole('dialog', { name: '技能管理' })).toBeNull()
  })

  it('imports a single SKILL.md file and sends its exact text', async () => {
    const installSkill = vi.fn(async (): Promise<SkillInstallOutcome> => ({
      ok: true,
      skill: { name: 'imported-skill', description: '导入技能', modelInvocable: true },
    }))
    const { view } = setup({ installSkill })
    await openManager()
    fireEvent.click(screen.getByRole('tab', { name: '导入 SKILL.md' }))
    const content = '---\nname: imported-skill\ndescription: 导入技能\n---\n\n执行导入说明。\n'
    const file = new File([content], 'SKILL.md', { type: 'text/markdown' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) })
    const input = view.baseElement.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    fireEvent.change(input!, { target: { files: [file] } })

    expect(await screen.findByText('SKILL.md')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }))
    await waitFor(() => { expect(installSkill).toHaveBeenCalledWith(content) })
  })

  it('keeps the manager open and explains a same-name refusal', async () => {
    setup({
      installSkill: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'skill/already-exists' },
      })),
    })
    await openManager()
    const dialog = screen.getByRole('dialog', { name: '技能管理' })
    fireEvent.change(within(dialog).getByLabelText('技能名称'), { target: { value: 'code-review' } })
    fireEvent.change(within(dialog).getByLabelText('功能说明'), { target: { value: '重复技能' } })
    fireEvent.change(within(dialog).getByLabelText('技能指令'), { target: { value: '重复说明' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存技能' }))

    expect((await within(dialog).findByRole('alert')).textContent).toContain('同名技能已存在，不会覆盖原文件')
    expect(screen.getByRole('dialog', { name: '技能管理' })).toBeDefined()
  })

  it('shows catalog loading failures and a retryable empty state', async () => {
    setup({ loadCatalog: vi.fn(() => Promise.reject(new Error('offline'))) })
    openPicker()
    expect((await screen.findByRole('alert')).textContent).toContain('技能加载失败，请重试')
  })
})
