/** Deterministic authenticated Runtime provider for the Ontology tool snapshot. */

/** Cordis plugin name. */
export const name = 'ontology-runtime-fixture'

/** Provide bounded Project and Action-preview responses without network credentials. */
export function apply(ctx) {
  const draft = {
    dataSources: [{ id: 'source-orders', label: 'Orders', description: '', kind: 'mock', enabled: true, readOnly: false }], objectTypes: [], linkTypes: [], actionTypes: [],
  }
  let updatedAt = '2026-11-12T10:00:00Z'
  const project = () => ({
    id: 'project-sales', name: 'Sales Operations', description: 'Published sales ontology',
    status: 'active', updatedAt, publishedVersion: 1,
  })
  ctx.provide('ontologyAuthController', {
    currentModelingContext: () => Promise.resolve(undefined),
    requestAuthenticated(request) {
      if (request.path === '/api/runtime/projects/project-sales/data-sources/inspect') {
        return Promise.resolve({
          dataSourceId: 'source-orders',
          resources: [{ ref: 'orders', label: 'Orders', kind: 'collection' }],
        })
      }
      if (request.path === '/api/runtime/projects/project-sales/draft') {
        if (request.method === 'GET') return Promise.resolve({ project: project(), draft, executors: [] })
        if (request.method === 'POST') {
          if (request.body.expectedUpdatedAt !== updatedAt) throw new Error('runtime_draft_conflict')
          if (request.body.bindings !== undefined) {
            for (const binding of request.body.bindings) {
              const object = draft.objectTypes.find(item => item.id === binding.objectTypeId)
              if (object === undefined) throw new Error('missing Object')
              object.resourceRef = binding.resourceRef
              object.primaryKey = binding.primaryKey
              for (const property of binding.properties) {
                const existing = object.properties.find(item => item.id === property.propertyId)
                if (existing === undefined) throw new Error('missing Property')
                existing.sourceField = property.sourceField
              }
            }
            updatedAt = '2026-11-12T10:02:00Z'
            return Promise.resolve({
              project: project(), draft, executors: [],
              updated: { objectTypes: 1, properties: 1, linkTypes: 0 },
            })
          }
          const additions = request.body.objectTypes ?? []
          draft.objectTypes.push(...additions)
          updatedAt = '2026-11-12T10:01:00Z'
          return Promise.resolve({
            project: project(), draft, executors: [],
            added: { objectTypes: additions.length, properties: 0, linkTypes: 0, actionTypes: 0 },
          })
        }
      }
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
