/** `ontology.login` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'ontology.login'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  eyebrow: 'Ontology Agent',
  brandName: 'Ontology Agent',
  title: '登录本体智能助手',
  description: '使用 Ontology 账号登录，访问已授权的项目与业务能力。',
  usernameLabel: '账号',
  usernamePlaceholder: '请输入账号',
  passwordLabel: '密码',
  passwordPlaceholder: '请输入密码',
  submit: '登录',
  submitting: '正在登录…',
  loading: '正在检查登录状态…',
  required: '请填写账号和密码。',
  defaultError: '登录失败，请稍后重试。',
  accountAria: '当前账号 {displayName}',
  accountTypeAdmin: '管理员',
  accountTypeMember: '普通用户',
  serviceLabel: 'Ontology 服务',
  logout: '退出登录',
  loggingOut: '正在退出…',
  markLabel: 'Ontology',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<OntologyLoginKey, string> = {
  eyebrow: 'Ontology Agent',
  brandName: 'Ontology Agent',
  title: 'Sign in to Ontology Agent',
  description: 'Use your Ontology account to access authorized projects and business capabilities.',
  usernameLabel: 'Account',
  usernamePlaceholder: 'Enter your account',
  passwordLabel: 'Password',
  passwordPlaceholder: 'Enter your password',
  submit: 'Sign in',
  submitting: 'Signing in…',
  loading: 'Checking sign-in status…',
  required: 'Enter your account and password.',
  defaultError: 'Sign-in failed. Try again later.',
  accountAria: 'Current account {displayName}',
  accountTypeAdmin: 'Administrator',
  accountTypeMember: 'Member',
  serviceLabel: 'Ontology service',
  logout: 'Sign out',
  loggingOut: 'Signing out…',
  markLabel: 'Ontology',
}

/** Key domain of the Ontology login namespace. */
export type OntologyLoginKey = keyof typeof zh
