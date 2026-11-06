/** Keyless platform replies for the real project-create tool and media plugin. */
import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-jdcloud-auth-controller'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'project-points-platform-fixture'

/**
 * Replace only platform authentication and transport; record any attempted project write.
 * @param ctx - Loader-owned fixture context.
 */
export function apply(ctx: Context): void {
  ctx.provide('jdcloudAuthController', {
    status: async () => ({ authenticated: true, corpId: '6ad80f2f1f280486bb45ac3a', baseUrl: 'https://mi.kindoucloud.com' }),
    currentScopeKey: async () => 'project-points-fixture',
    owns: async () => true,
    requestAuthenticated: async (request: { path: string; body?: { menuId?: string; _id?: string } }) => {
      if (request.path === '/api/oauth/currentUser') {
        return { userInfo: { id: 'owner', corpId: '6ad80f2f1f280486bb45ac3a' } }
      }
      if (request.path === '/api/visualdev/form/info' && request.body?.menuId === '6adb0fbec3ca9f3dcdaf499a') {
        return { _id: 'a'.repeat(24), ownerUserId: 'owner', status: 'active', points: '0' }
      }
      if (request.path === '/api/visualdev/form/info' && request.body?.menuId === '6ad81c131f280486bb45ac3f') {
        return { _id: 'b'.repeat(24), spaceId: 'a'.repeat(24) }
      }
      if (request.path === '/api/visualdev/form/list') return { list: [] }
      if (request.path === '/api/visualdev/form/create') {
        if (request.body?.menuId === '6ad81c131f280486bb45ac3f') {
          await writeFile('unexpected-project-created.json', JSON.stringify(request.body))
        }
        return 'b'.repeat(24)
      }
      throw new Error(`Unexpected fixture request: ${request.path}`)
    },
  } as never)
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: ['jdcloud_lowcode_create'] })
  })
}
