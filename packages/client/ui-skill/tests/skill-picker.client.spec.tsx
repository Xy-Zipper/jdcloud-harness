// @vitest-environment jsdom
/** Visual skill discovery and current-workspace installation behavior. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  SkillInstallFile,
  SkillInstallScope,
  SkillManagedEntry,
  SkillManagedScope,
} from '@deepseek-ai/dsh-api-session-controller/types'
import {
  SkillPickerView,
  type SkillDeleteOutcome,
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
  readonly installSkill?: (
    scope: SkillInstallScope,
    files: readonly SkillInstallFile[],
  ) => Promise<SkillInstallOutcome>
  readonly deleteSkill?: (scope: SkillManagedScope, name: string) => Promise<SkillDeleteOutcome>
  readonly loadCatalog?: () => Promise<{
    skills: typeof catalog
    installScopes: readonly SkillInstallScope[]
    managedSkills: readonly SkillManagedEntry[]
  }>
} = {}) {
  const inputActions = options.inputActions ?? actions()
  const installSkill = options.installSkill ?? vi.fn(async (
    _scope: SkillInstallScope,
    files: readonly SkillInstallFile[],
  ): Promise<SkillInstallOutcome> => ({
    ok: true as const,
    skill: {
      name: atob(files.find(file => file.path === 'SKILL.md')?.contentBase64 ?? '').includes('name: imported-skill')
        ? 'imported-skill'
        : 'workspace-helper',
      description: '自定义技能',
      modelInvocable: true,
    },
  }))
  const loadCatalog = options.loadCatalog ?? vi.fn(() => Promise.resolve({
    skills: catalog,
    installScopes: ['personal'] as const,
    managedSkills: [],
  }))
  const deleteSkill = options.deleteSkill ?? vi.fn(() => Promise.resolve({ ok: true as const }))
  const view = render(<SkillPickerView
    available={options.available ?? true}
    inputActions={inputActions}
    installSkill={installSkill}
    deleteSkill={deleteSkill}
    loadCatalog={loadCatalog}
    t={t}
  />)
  return { deleteSkill, inputActions, installSkill, loadCatalog, view }
}

/** Build one browser directory entry with deterministic bytes for jsdom. */
function folderFile(path: string, content: string | Uint8Array): File {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  const file = new File([Uint8Array.from(bytes).buffer], path.split('/').at(-1) ?? path)
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  Object.defineProperty(file, 'arrayBuffer', {
    value: () => Promise.resolve(Uint8Array.from(bytes).buffer),
  })
  return file
}

/** Decode browser Base64 as UTF-8 for readable assertions. */
function decodeBase64Text(encoded: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)))
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

  it('offers folder import without a skill creation form', async () => {
    setup()
    await openManager()
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeDefined()
    expect(screen.queryByText('新建技能')).toBeNull()
    expect(screen.queryByLabelText('技能名称')).toBeNull()
  })

  it('imports every selected folder file with its relative path and exact bytes', async () => {
    const installSkill = vi.fn(async (
      _scope: SkillInstallScope,
      _files: readonly SkillInstallFile[],
    ): Promise<SkillInstallOutcome> => ({
      ok: true,
      skill: { name: 'imported-skill', description: '导入技能', modelInvocable: true },
    }))
    const { view } = setup({ installSkill })
    await openManager()
    const content = '---\nname: imported-skill\ndescription: 导入技能\n---\n\n执行导入说明。\n'
    const skill = folderFile('imported-skill/SKILL.md', content)
    const asset = folderFile('imported-skill/assets/icon.png', Uint8Array.of(0, 255, 7))
    const input = view.baseElement.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    fireEvent.change(input!, { target: { files: [skill, asset] } })

    expect(await screen.findByText('已读取 2 个文件')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
    await waitFor(() => {
      expect(installSkill).toHaveBeenCalledOnce()
      expect(installSkill.mock.calls[0]?.[0]).toBe('personal')
      const files = installSkill.mock.calls[0]?.[1]
      expect(files?.map(file => file.path)).toEqual(['SKILL.md', 'assets/icon.png'])
      expect(decodeBase64Text(files?.[0]?.contentBase64 ?? '')).toBe(content)
      expect(Uint8Array.from(atob(files?.[1]?.contentBase64 ?? ''), character => character.charCodeAt(0)))
        .toEqual(Uint8Array.of(0, 255, 7))
    })
  })

  it('rejects a folder without a root SKILL.md before calling the adapter', async () => {
    const installSkill = vi.fn()
    const { view } = setup({ installSkill })
    await openManager()
    const input = view.baseElement.querySelector<HTMLInputElement>('input[type="file"]')
    fireEvent.change(input!, {
      target: { files: [folderFile('incomplete/references/guide.md', 'guide')] },
    })

    expect((await screen.findByRole('alert')).textContent).toBe('文件夹根目录缺少 SKILL.md')
    expect(screen.getByRole('button', { name: '导入技能' }).hasAttribute('disabled')).toBe(true)
    expect(installSkill).not.toHaveBeenCalled()
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
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')
    fireEvent.change(input!, {
      target: { files: [folderFile('code-review/SKILL.md', '---\nname: code-review\ndescription: 重复技能\n---\n')] },
    })
    await within(dialog).findByText('已读取 1 个文件')
    fireEvent.click(within(dialog).getByRole('button', { name: '导入技能' }))

    expect((await within(dialog).findByRole('alert')).textContent).toContain('同名技能已存在，不会覆盖原文件')
    expect(screen.getByRole('dialog', { name: '技能管理' })).toBeDefined()
  })

  it('lets administrators choose the shared built-in target', async () => {
    const installSkill = vi.fn(async (
      _scope: SkillInstallScope,
      _files: readonly SkillInstallFile[],
    ): Promise<SkillInstallOutcome> => ({
      ok: true,
      skill: { name: 'shared-skill', description: '共享技能', modelInvocable: true },
    }))
    const { view } = setup({
      installSkill,
      loadCatalog: vi.fn(() => Promise.resolve({
        skills: catalog,
        installScopes: ['personal', 'built-in'] as const,
        managedSkills: [],
      })),
    })
    await openManager()
    expect(screen.getByRole('tab', { name: '我的技能' }).getAttribute('aria-selected')).toBe('true')
    const builtInTab = screen.getByRole('tab', { name: '内置技能' })
    fireEvent.click(builtInTab)
    expect(builtInTab.getAttribute('aria-selected')).toBe('true')
    const input = view.baseElement.querySelector<HTMLInputElement>('input[type="file"]')
    fireEvent.change(input!, {
      target: { files: [folderFile('shared-skill/SKILL.md', '---\nname: shared-skill\ndescription: 共享技能\n---\n')] },
    })
    await screen.findByText('已读取 1 个文件')
    fireEvent.click(screen.getByRole('button', { name: '导入技能' }))

    await waitFor(() => { expect(installSkill.mock.calls[0]?.[0]).toBe('built-in') })
  })

  it('opens the same administrator tabs from Settings', async () => {
    const installSkill = vi.fn(async (): Promise<SkillInstallOutcome> => ({
      ok: true,
      skill: { name: 'shared-skill', description: '共享技能', modelInvocable: true },
    }))
    render(<SkillPickerView
      surface="settings"
      available
      installSkill={installSkill}
      deleteSkill={() => Promise.resolve({ ok: true })}
      loadCatalog={() => Promise.resolve({
        skills: catalog,
        installScopes: ['personal', 'built-in'],
        managedSkills: [],
      })}
      t={t}
    />)

    expect(await screen.findByRole('heading', { name: '技能管理' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '管理技能' }))
    await screen.findByRole('dialog', { name: '技能管理' })
    expect(screen.getByRole('tab', { name: '我的技能' })).toBeDefined()
    expect(screen.getByRole('tab', { name: '内置技能' })).toBeDefined()
  })

  it('shows catalog loading failures and a retryable empty state', async () => {
    setup({ loadCatalog: vi.fn(() => Promise.reject(new Error('offline'))) })
    openPicker()
    expect((await screen.findByRole('alert')).textContent).toContain('技能加载失败，请重试')
  })

  it('lists installed skills and confirms before deleting the selected scope', async () => {
    const deleteSkill = vi.fn(() => Promise.resolve({ ok: true as const }))
    setup({
      deleteSkill,
      loadCatalog: vi.fn(() => Promise.resolve({
        skills: catalog,
        installScopes: ['personal', 'built-in'] as const,
        managedSkills: [
          {
            name: 'personal-helper',
            description: '我的账号技能',
            modelInvocable: true,
            scope: 'personal' as const,
          },
          {
            name: 'shared-helper',
            description: '所有用户共享',
            modelInvocable: true,
            scope: 'built-in' as const,
          },
        ],
      })),
    })
    await openManager()

    expect(screen.getByText('personal-helper')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '删除 personal-helper' }))
    expect(screen.getByRole('dialog', { name: '删除技能' })).toBeDefined()
    expect(deleteSkill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(deleteSkill).toHaveBeenCalledWith('personal', 'personal-helper') })
    await waitFor(() => { expect(screen.queryByText('personal-helper')).toBeNull() })

    fireEvent.click(screen.getByRole('tab', { name: '内置技能' }))
    expect(screen.getByText('shared-helper')).toBeDefined()
  })
})
