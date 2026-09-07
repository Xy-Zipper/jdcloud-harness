/** `jdcloud.login` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'jdcloud.login'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  eyebrow: 'JDCloud 低代码平台',
  title: '欢迎登录',
  description: '登录后即可继续使用低代码智能助手。',
  serviceLabel: '服务地址',
  servicePlaceholder: 'https://example.com',
  usernameLabel: '账号',
  usernamePlaceholder: '请输入账号',
  passwordLabel: '密码',
  passwordPlaceholder: '请输入密码',
  submit: '登录',
  submitting: '正在登录…',
  loading: '正在检查登录状态…',
  required: '请填写服务地址、账号和密码。',
  defaultError: '登录失败，请稍后重试。',
  accountAria: '当前账号 {username}，租户 {corpName}',
  tenantList: '租户',
  switchingTenant: '正在切换到 {corpName}…',
  switchTenantFailed: '切换租户失败，请稍后重试。',
  logout: '退出登录',
  loggingOut: '正在退出…',
  markLabel: 'JDCloud',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<JdcloudLoginKey, string> = {
  eyebrow: 'JDCloud Low-Code Platform',
  title: 'Welcome back',
  description: 'Sign in to continue using the low-code assistant.',
  serviceLabel: 'Service address',
  servicePlaceholder: 'https://example.com',
  usernameLabel: 'Account',
  usernamePlaceholder: 'Enter your account',
  passwordLabel: 'Password',
  passwordPlaceholder: 'Enter your password',
  submit: 'Sign in',
  submitting: 'Signing in…',
  loading: 'Checking sign-in status…',
  required: 'Enter the service address, account, and password.',
  defaultError: 'Sign-in failed. Try again later.',
  accountAria: 'Current account {username}, tenant {corpName}',
  tenantList: 'Tenants',
  switchingTenant: 'Switching to {corpName}…',
  switchTenantFailed: 'Could not switch tenants. Try again later.',
  logout: 'Sign out',
  loggingOut: 'Signing out…',
  markLabel: 'JDCloud',
}

/** Key domain of the JDCloud login namespace. */
export type JdcloudLoginKey = keyof typeof zh
