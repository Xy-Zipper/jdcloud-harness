/** Deterministic authenticated Runtime provider for the Ontology tool snapshot. */

/** Cordis plugin name. */
export const name = 'ontology-runtime-fixture'

/** Provide bounded Project and Action-preview responses without network credentials. */
export function apply(ctx) {
  ctx.provide('ontologyAuthController', {
    requestAuthenticated(request) {
      if (request.method === 'GET' && request.path === '/api/runtime/projects') {
        return Promise.resolve({
          projects: [{
            id: 'project-sales',
            name: 'Sales Operations',
            description: 'Published sales ontology',
            releaseVersion: '2026.10.10',
          }],
        })
      }
      if (request.method === 'GET' && request.path === '/api/runtime/action-invocations/invocation-snapshot') {
        return Promise.resolve({
          invocationId: 'invocation-snapshot',
          projectId: 'project-sales',
          actionTypeId: 'action-update-order',
          actionKind: 'object',
          expiresAt: '2026-10-10T23:00:00Z',
          requiresConfirmation: true,
          summary: 'Update order order-snapshot',
          affectedObjects: [{ objectTypeId: 'object-order', primaryKey: 'order-snapshot' }],
          status: 'prepared',
        })
      }
      throw new Error(`ontology-runtime-fixture: unexpected request ${request.method} ${request.path}`)
    },
  })
}
