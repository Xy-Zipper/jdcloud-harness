import { describe, expect, it } from 'vitest'
import {
  parseCurrentMemberLookup,
  parseCurrentMemberNames,
  parseCurrentUserCapabilities,
  renderCapabilitySnapshot,
} from '../src/current-user.ts'

/** Build the unwrapped `/api/oauth/currentUser` data used by parser cases. */
function currentUser(menuList: readonly unknown[], userPermission?: unknown): Record<string, unknown> {
  return {
    userInfo: { id: 'user-1', departmentId: [], roleId: [] },
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

describe('current-member wire validation coverage', () => {
  it('batches unique current-user ids and restores each member kind in current-user order', () => {
    const lookup = parseCurrentMemberLookup({
      userInfo: {
        id: ' user-1 ',
        departmentId: ['department-2', 'department-1', 'department-2'],
        roleId: ['role-1'],
      },
    })

    expect(lookup).toEqual({
      ids: ['user-1', 'department-2', 'department-1', 'role-1'],
      userId: 'user-1',
      departmentIds: ['department-2', 'department-1'],
      roleIds: ['role-1'],
    })
    expect(parseCurrentMemberNames(lookup, {
      department: [
        { id: 'department-1', fullName: '研发一部' },
        { id: 'department-extra', fullName: '未请求部门' },
        { id: 'department-2', fullName: '研发二部' },
      ],
      role: [{ id: 'role-1', fullName: '开发人员' }],
      user: [
        { id: 'user-extra', fullName: '其他用户', phone: '' },
        { id: 'user-1', fullName: '测试用户', phone: '13800000000' },
      ],
    })).toEqual({
      department: [
        { id: 'department-2', fullName: '研发二部' },
        { id: 'department-1', fullName: '研发一部' },
      ],
      role: [{ id: 'role-1', fullName: '开发人员' }],
      user: [{ id: 'user-1', fullName: '测试用户', phone: '13800000000' }],
    })
  })

  it('rejects malformed current-user member ids', () => {
    expect(() => parseCurrentMemberLookup(undefined)).toThrow('current-user response is invalid')
    expect(() => parseCurrentMemberLookup({ userInfo: null })).toThrow('current-user profile is invalid')
    expect(() => parseCurrentMemberLookup({
      userInfo: { id: '', departmentId: [], roleId: [] },
    })).toThrow('current-user id is invalid')
    expect(() => parseCurrentMemberLookup({
      userInfo: { id: 'user-1', departmentId: null, roleId: [] },
    })).toThrow('department ids are invalid')
    expect(() => parseCurrentMemberLookup({
      userInfo: { id: 'user-1', departmentId: [1], roleId: [] },
    })).toThrow('department ids is invalid')
    expect(() => parseCurrentMemberLookup({
      userInfo: { id: 'user-1', departmentId: [], roleId: 'role-1' },
    })).toThrow('role ids are invalid')
  })

  it('rejects malformed member-name collections and entries', () => {
    const lookup = parseCurrentMemberLookup({
      userInfo: { id: 'user-1', departmentId: ['department-1'], roleId: ['role-1'] },
    })
    const valid = {
      department: [{ id: 'department-1', fullName: '研发部' }],
      role: [{ id: 'role-1', fullName: '开发人员' }],
      user: [{ id: 'user-1', fullName: '测试用户', phone: '' }],
    }

    expect(() => parseCurrentMemberNames(lookup, null)).toThrow('member-name response is invalid')
    expect(() => parseCurrentMemberNames(lookup, { ...valid, department: null }))
      .toThrow('department list is invalid')
    expect(() => parseCurrentMemberNames(lookup, { ...valid, role: null }))
      .toThrow('role list is invalid')
    expect(() => parseCurrentMemberNames(lookup, { ...valid, user: null }))
      .toThrow('user list is invalid')
    expect(() => parseCurrentMemberNames(lookup, { ...valid, department: [null] }))
      .toThrow('member-name department is invalid')
    expect(() => parseCurrentMemberNames(lookup, {
      ...valid,
      department: [{ id: '', fullName: '研发部' }],
    })).toThrow('member-name department id is invalid')
    expect(() => parseCurrentMemberNames(lookup, {
      ...valid,
      department: [
        { id: 'department-1', fullName: '研发部' },
        { id: 'department-1', fullName: '重复部门' },
      ],
    })).toThrow('repeats department "department-1"')
    expect(() => parseCurrentMemberNames(lookup, {
      ...valid,
      role: [{ id: 'role-1', fullName: '' }],
    })).toThrow('member-name role "role-1" name is invalid')
    expect(() => parseCurrentMemberNames(lookup, { ...valid, user: [null] }))
      .toThrow('member-name user is invalid')
    expect(() => parseCurrentMemberNames(lookup, {
      ...valid,
      user: [{ id: '', fullName: '测试用户', phone: '' }],
    })).toThrow('member-name user id is invalid')
    expect(() => parseCurrentMemberNames(lookup, {
      ...valid,
      user: [
        { id: 'user-1', fullName: '测试用户', phone: '' },
        { id: 'user-1', fullName: '重复用户', phone: '' },
      ],
    })).toThrow('repeats user "user-1"')
    expect(() => parseCurrentMemberNames(lookup, {
      ...valid,
      user: [{ id: 'user-1', fullName: '', phone: '' }],
    })).toThrow('member-name user "user-1" name is invalid')
    expect(() => parseCurrentMemberNames(lookup, {
      ...valid,
      user: [{ id: 'user-1', fullName: '测试用户', phone: null }],
    })).toThrow('member-name user "user-1" phone is invalid')
  })

  it('rejects a member-name response that omits a current-user selection', () => {
    const lookup = parseCurrentMemberLookup({
      userInfo: { id: 'user-1', departmentId: ['department-1'], roleId: ['role-1'] },
    })
    const valid = {
      department: [{ id: 'department-1', fullName: '研发部' }],
      role: [{ id: 'role-1', fullName: '开发人员' }],
      user: [{ id: 'user-1', fullName: '测试用户', phone: '' }],
    }

    expect(() => parseCurrentMemberNames(lookup, { ...valid, department: [] }))
      .toThrow('has no department for "department-1"')
    expect(() => parseCurrentMemberNames(lookup, { ...valid, role: [] }))
      .toThrow('has no role for "role-1"')
    expect(() => parseCurrentMemberNames(lookup, { ...valid, user: [] }))
      .toThrow('has no user for "user-1"')
  })
})

describe('current-user model snapshot coverage', () => {
  it('renders form and workflow menu types without retaining the turn', () => {
    const text = renderCapabilitySnapshot({
      turn: 8,
      corpId: 'corp-1',
      corpName: 'Tenant',
      systemAdministrator: true,
      currentMember: {
        department: [],
        role: [],
        user: [{ id: 'user-1', fullName: 'Tester', phone: '' }],
      },
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
      currentMember: {
        department: [],
        role: [],
        user: [{ id: 'user-1', fullName: 'Tester', phone: '' }],
      },
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
