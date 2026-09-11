/** `jdcloud.lowcodeActions` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'jdcloud.lowcodeActions'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  panelAria: '可用的低代码功能',
  unavailable: '所选低代码功能在当前租户中不可用，请重新选择。',
  invalidReference: '低代码功能标签无效，请删除后重新选择。',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<JdcloudLowcodeActionKey, string> = {
  panelAria: 'Available low-code functions',
  unavailable: 'The selected low-code function is unavailable in the current tenant. Select it again.',
  invalidReference: 'The low-code function tag is invalid. Remove it and select the function again.',
}

/** Key domain of the JDCloud low-code action namespace. */
export type JdcloudLowcodeActionKey = keyof typeof zh
