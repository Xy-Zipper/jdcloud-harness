import { describe, expect, it } from 'vitest'
import {
  parseCurrentUserCapabilities,
  renderCapabilitySnapshot,
} from '../src/current-user.ts'

/** Build the unwrapped `/api/oauth/currentUser` data used by parser cases. */
function currentUser(menuList: readonly unknown[], userPermission?: unknown): Record<string, unknown> {
  return {
    userInfo: { id: 'user-1' },
    menuList,
    ...(userPermission === undefined ? {} : { userPermission }),
  }
}

describe('current-user wire validation coverage', () => {
  it('rejects invalid response, profile, and menu-list containers', () => {
    expect(() => parseCurrentUserCapabilities(undefined)).toThrow('current-user response is invalid')
    expect(() => parseCurrentUserCapabilities(null)).toThrow('current-user response is invalid')
    expect(() => parseCurrentUserCapabilities([])).toThrow('current-user response is invalid')
    expect(() => parseCurrentUserCapabilities({ userInfo: null, menuList: [] }))
      .toThrow('current-user profile is invalid')
    expect(() => parseCurrentUserCapabilities({ userInfo: [], menuList: [] }))
      .toThrow('current-user profile is invalid')
    expect(() => parseCurrentUserCapabilities({ userInfo: {}, menuList: null }))
      .toThrow('has no menu list')
  })

  it('rejects malformed menu identities, types, parents, children, and permissions', () => {
    expect(() => parseCurrentUserCapabilities(currentUser([null])))
      .toThrow('current-user menu item is invalid')
    expect(() => parseCurrentUserCapabilities(currentUser([{ id: 1, fullName: 'A', type: 3 }])))
      .toThrow('JDCloud menu id is invalid')
    expect(() => parseCurrentUserCapabilities(currentUser([{ id: ' ', fullName: 'A', type: 3 }])))
      .toThrow('JDCloud menu id is invalid')
    expect(() => parseCurrentUserCapabilities(currentUser([{ id: 'a', fullName: ' ', type: 3 }])))
      .toThrow('menu "a" name is invalid')
    expect(() => parseCurrentUserCapabilities(currentUser([{ id: 'a', fullName: 'A', type: '3' }])))
      .toThrow('menu "a" has an invalid type')
    expect(() => parseCurrentUserCapabilities(currentUser([{ id: 'a', fullName: 'A', type: 3.5 }])))
      .toThrow('menu "a" has an invalid type')
    expect(() => parseCurrentUserCapabilities(currentUser([{
      id: 'a', fullName: 'A', type: 3, parentId: ' ',
    }])))
      .toThrow('menu "a" parent id is invalid')
    expect(() => parseCurrentUserCapabilities(currentUser([{
      id: 'a', fullName: 'A', type: 3, children: {},
    }])))
      .toThrow('menu "a" has an invalid child list')
    expect(() => parseCurrentUserCapabilities(currentUser([{
      id: 'a', fullName: 'A', type: 3, agentPermissions: 'addData',
    }])))
      .toThrow('agentPermissions must be an array')
    expect(() => parseCurrentUserCapabilities(currentUser([
      { id: 'a', fullName: 'A', type: 3 },
      { id: 'a', fullName: 'Again', type: 4 },
    ]))).toThrow('repeats menu "a"')
  })

  it('flattens nested menus, resolves parent variants, and filters permissions and menu kinds', () => {
    const parsed = parseCurrentUserCapabilities(currentUser([
      {
        id: 'folder',
        parentId: '-1',
        fullName: 'Folder',
        type: 1,
        children: [
          {
            id: 'form',
            fullName: 'Form',
            type: 3,
            agentPermissions: ['addData', 1, 'unknown', 'addData', 'editData', 'deleteData'],
          },
          { id: 'flow', parentId: null, fullName: 'Flow', type: 4, children: null },
          { id: 'board', parentId: '', fullName: 'Board', type: 6, children: [] },
        ],
      },
      { id: 'orphan', parentId: 'missing', fullName: 'Orphan', type: 3 },
      { id: 'top', fullName: 'Top', type: 4 },
    ], { systemAdministrator: true }))

    expect(parsed).toEqual({
      systemAdministrator: true,
      menus: [
        {
          menuId: 'form',
          fullName: 'Form',
          path: 'Folder / Form',
          type: 3,
          agentPermissions: ['addData', 'editData', 'deleteData'],
        },
        {
          menuId: 'flow',
          fullName: 'Flow',
          path: 'Folder / Flow',
          type: 4,
          agentPermissions: [],
        },
        {
          menuId: 'orphan',
          fullName: 'Orphan',
          path: 'Orphan',
          type: 3,
          agentPermissions: [],
        },
        {
          menuId: 'top',
          fullName: 'Top',
          path: 'Top',
          type: 4,
          agentPermissions: [],
        },
      ],
    })
    expect(parseCurrentUserCapabilities(currentUser([], { systemAdministrator: false })))
      .toEqual({ systemAdministrator: false, menus: [] })
    expect(parseCurrentUserCapabilities(currentUser([], [])))
      .toEqual({ systemAdministrator: false, menus: [] })
  })

  it('rejects menu-parent cycles', () => {
    expect(() => parseCurrentUserCapabilities(currentUser([
      { id: 'a', parentId: 'b', fullName: 'A', type: 3 },
      { id: 'b', parentId: 'a', fullName: 'B', type: 1 },
    ]))).toThrow('menu-parent cycle at "a"')
  })

})

describe('current-user model snapshot coverage', () => {
  it('renders form and workflow menu types without retaining the turn', () => {
    const text = renderCapabilitySnapshot({
      turn: 8,
      corpId: 'corp-1',
      corpName: 'Tenant',
      systemAdministrator: true,
      menus: [
        {
          menuId: 'form', fullName: 'Form', path: 'Folder / Form', type: 3, agentPermissions: ['addData'],
        },
        {
          menuId: 'flow', fullName: 'Flow', path: 'Folder / Flow', type: 4, agentPermissions: [],
        },
      ],
    })

    expect(JSON.parse(text.slice(text.indexOf('\n') + 1))).toEqual({
      tenant: { id: 'corp-1', name: 'Tenant' },
      systemAdministrator: true,
      functions: [
        {
          menuId: 'form', fullName: 'Form', path: 'Folder / Form', type: 'form', agentPermissions: ['addData'],
        },
        {
          menuId: 'flow', fullName: 'Flow', path: 'Folder / Flow', type: 'workflow', agentPermissions: [],
        },
      ],
    })
    expect(text).not.toContain('"turn"')
  })
})
