// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, it, vi } from 'vitest'
import { SkillRelease } from '../src/client/SkillRelease.tsx'
import { KnowledgeSkillPage } from '../src/client/KnowledgeSkillPage.tsx'
import { knowledgeRequest } from '../src/client/knowledge-api.ts'
import { zh, type OntologyLoginKey } from '../src/client/locales.ts'

vi.mock('../src/client/knowledge-api.ts', () => ({ knowledgeRequest: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

const t: PropsLocale<'ontology.login'>['t'] = key => zh[key as OntologyLoginKey] ?? key

it('provides distinct browser and server integration codes for the same released role', () => {
  const base = document.createElement('base')
  base.href = 'https://workbench.example/harness/'
  document.head.append(base)
  try {
    const draft = { name: '资料助手', instructions: '', datasetIds: ['training'] }
    const onAction = vi.fn()
    render(<SkillRelease skill={{ id: 'ks_demo', projectId: 'project-training', draft, published: draft, revision: 1,
      version: 1, delivery: { embedToken: 'ose_example', apiKeys: [{ id: 'sk_existing', preview: 'osk_ABC…TEST', createdAt: '2026-11-20T00:00:00Z' }] } }}
    busy={false} onAction={onAction} onClearKey={() => {}} t={t} />)
    const iframe = screen.getByLabelText<HTMLTextAreaElement>('iframe 嵌入代码').value
    expect(iframe).toContain('https://workbench.example/harness/api/ontology-skill/v1/chat#ose_example')
    fireEvent.click(screen.getByRole('button', { name: '悬浮组件' }))
    const widget = screen.getByLabelText<HTMLTextAreaElement>('悬浮组件嵌入代码').value
    expect(widget).toContain('https://workbench.example/harness/api/ontology-skill/v1/widget.js')
    expect(widget).toContain('data-skill-share="ose_example"')
    fireEvent.click(screen.getByRole('button', { name: 'API 接口' }))
    const reference = screen.getByRole('region', { name: 'API 接口文档' })
    fireEvent.click(within(reference).getByText('发起对话', { exact: true }))
    const curl = reference.textContent ?? ''
    expect(curl).toContain('/harness/api/ontology-skill/v1/skills/ks_demo/chat')
    expect(curl).toContain('GET /sessions/{sessionId}')
    expect(curl).toContain('DELETE /sessions/{sessionId}')
    expect(curl).toContain('Bearer <API_KEY>')
    expect(curl).toContain('curl --no-buffer --request POST')
    expect(curl).toContain('"stream":true')
    expect(curl).toContain('event: done')
    expect(curl).toContain('响应字段')
    expect(curl).toContain('此次回答使用的 Skill 发布版本')
    expect(curl).toContain('RAGFlow 知识库 ID')
    expect(curl).not.toContain('ose_example')
    fireEvent.click(screen.getByRole('button', { name: '管理 API Key' }))
    const keys = within(screen.getByRole('dialog', { name: 'API Key' }))
    expect(keys.getByText('osk_ABC…TEST')).toBeTruthy()
    fireEvent.click(keys.getByRole('button', { name: '创建新密钥' }))
    expect(onAction).toHaveBeenCalledWith('issue-key')
    fireEvent.click(within(keys.getByRole('row', { name: /osk_ABC/u })).getByRole('button', { name: /删除密钥/u }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除密钥' })).getByRole('button', { name: '确认删除' }))
    expect(onAction).toHaveBeenCalledWith('revoke-key', 'sk_existing')
  } finally {
    base.remove()
  }
})

it('keeps saved roles visible and retries a failed knowledge base catalog', async () => {
  const draft = { name: '资料助手', instructions: '', datasetIds: ['training'] }
  let catalogAttempts = 0
  vi.mocked(knowledgeRequest).mockImplementation(async (path) => {
    if (path === 'projects/project-training/skills') return Response.json({ skills: [{ id: 'ks_demo', projectId: 'project-training', draft, revision: 1, version: 0 }] })
    if (++catalogAttempts === 1) throw new Error('知识检索服务不可用：无法连接 RAGFlow')
    return Response.json({ projects: [{ id: 'project-training', name: '培训' }], datasets: [{ id: 'training', name: '培训资料' }] })
  })
  render(<KnowledgeSkillPage t={t} close={() => {}} project={{ id: 'project-training', name: '培训' }} />)
  expect((await screen.findByRole('alert')).textContent).toContain('无法连接 RAGFlow')
  fireEvent.click(screen.getByRole('button', { name: /资料助手/u }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: t('knowledgeSave') }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect((await screen.findByRole<HTMLInputElement>('checkbox', { name: '培训资料' })).checked).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: t('knowledgeSave') }).disabled).toBe(false)
})

it('shows the current project alone and confirms the scoped deletion', async () => {
  const a = { id: 'project-a', name: '项目甲' }
  const b = { id: 'project-b', name: '项目乙' }
  const item = (projectId: string, name: string) => ({ id: 'ks_demo', projectId, draft: { name, instructions: '', datasetIds: [] }, revision: 1, version: 0 })
  vi.mocked(knowledgeRequest).mockImplementation(async (path, _signal, _body, method) => {
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (path === 'catalog') return Response.json({ projects: [a, b], datasets: [] })
    return Response.json({ skills: [item(a.id, '甲项目角色'), item(b.id, '乙项目角色')] })
  })
  const page = render(<KnowledgeSkillPage t={t} close={() => {}} project={a} />)
  await screen.findByRole('button', { name: /甲项目角色/u })
  expect(screen.queryByText('乙项目角色')).toBeNull()
  page.rerender(<KnowledgeSkillPage t={t} close={() => {}} project={b} />)
  expect(screen.queryByText('甲项目角色')).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: /乙项目角色/u }))
  fireEvent.click(screen.getByRole('button', { name: '删除 Skill' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '删除 Skill' })).getByRole('button', { name: '确认删除' }))
  expect(await screen.findByText('Skill 已删除')).toBeTruthy()
  expect(screen.queryByText('乙项目角色')).toBeNull()
  expect(knowledgeRequest).toHaveBeenCalledWith('projects/project-b/skills/ks_demo', expect.any(AbortSignal), undefined, 'DELETE')
})
