/** Build JDCloud form configuration from the supported table-field vocabulary. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Field kinds that this plugin can safely translate to JDCloud component schemas. */
export type TableFieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'switch'
  | 'single_select'
  | 'multi_select'
  | 'date'
  | 'time'

/** One static selection option stored by its explicit value. */
export interface TableFieldOption {
  readonly label: string
  readonly value: string
}

/** One model-authored field in a new JDCloud form. */
export interface TableFieldInput {
  readonly enCode: string
  readonly label: string
  readonly kind: TableFieldKind
  readonly required: boolean
  readonly options?: readonly TableFieldOption[]
}

const FIELD_CODE = /^[A-Za-z_][A-Za-z0-9_]*$/
const OPTION_COLOR = '#46c26f'

/**
 * Build a complete serializable JDCloud `formData` object.
 * @param fields - Supported fields requested for the new form.
 * @returns JDCloud generator-compatible form configuration.
 */
export function buildFormData(fields: readonly TableFieldInput[]): Record<string, JsonValue> {
  if (fields.length === 0) throw new TypeError('JDCloud table requires at least one field')
  const seen = new Set<string>()
  const rendered = fields.map((field, index) => {
    const enCode = field.enCode.trim()
    const label = field.label.trim()
    if (!FIELD_CODE.test(enCode)) {
      throw new TypeError(`JDCloud field code ${JSON.stringify(field.enCode)} is invalid`)
    }
    if (seen.has(enCode)) throw new TypeError(`JDCloud field code ${JSON.stringify(enCode)} is duplicated`)
    if (label === '') throw new TypeError(`JDCloud field ${JSON.stringify(enCode)} requires a label`)
    seen.add(enCode)
    const fieldId = 101 + index
    return buildField({ ...field, enCode, label }, fieldId)
  })
  return {
    formRef: 'elForm',
    category: 'Web',
    formModel: 'dataForm',
    size: 'medium',
    labelPosition: 'right',
    labelWidth: 100,
    formRules: 'rules',
    gutter: 15,
    span: 24,
    formBtns: false,
    cancelButtonText: '取 消',
    confirmButtonText: '确 定',
    formStyle: '',
    idGlobal: 100 + fields.length,
    hideRules: [],
    disabled: false,
    fields: rendered,
  }
}

/** Translate one supported field to the matching generator component template. */
function buildField(field: TableFieldInput, fieldId: number): Record<string, JsonValue> {
  const identity = {
    __vModel__: field.enCode,
    __config__: {
      ...commonConfig(field, fieldId),
    },
  }
  switch (field.kind) {
    case 'text':
      rejectUnexpectedOptions(field)
      return {
        ...identity,
        __config__: {
          ...identity.__config__,
          jdcloudKey: 'comInput',
          formulaConf: {},
          defaultValueType: 'custom',
          tagIcon: 'iconfont icon-text',
          regList: [],
          trigger: ['blur', 'change'],
          dataType: 'static',
          linkageQuery: {},
        },
        __slot__: { prepend: '', append: '' },
        placeholder: '请输入',
        style: { width: '100%' },
        scan: false,
        clearable: true,
        'prefix-icon': '',
        'suffix-icon': '',
        maxlength: null,
        'show-word-limit': false,
        readonly: false,
        disabled: false,
      }
    case 'textarea':
      rejectUnexpectedOptions(field)
      return {
        ...identity,
        __config__: {
          ...identity.__config__,
          jdcloudKey: 'textarea',
          formulaConf: {},
          defaultValueType: 'custom',
          tagIcon: 'iconfont icon-multi-line',
          regList: [],
          trigger: 'blur',
          linkageQuery: {},
        },
        type: 'textarea',
        placeholder: '请输入',
        autosize: { minRows: 4, maxRows: 4 },
        style: { width: '100%' },
        maxlength: null,
        'show-word-limit': true,
        readonly: false,
        disabled: false,
      }
    case 'number':
      rejectUnexpectedOptions(field)
      return {
        ...identity,
        __config__: {
          ...identity.__config__,
          jdcloudKey: 'numInput',
          tagIcon: 'iconfont icon-number',
          formulaConf: {},
          defaultValueType: 'custom',
          regList: [],
          trigger: ['blur', 'change'],
          linkageQuery: {},
        },
        placeholder: '数字文本',
        step: 1,
        'step-strictly': false,
        'controls-position': '',
        disabled: false,
      }
    case 'switch':
      rejectUnexpectedOptions(field)
      return {
        ...identity,
        __config__: {
          ...identity.__config__,
          jdcloudKey: 'switch',
          tagIcon: 'iconfont icon-switch',
          defaultValue: false,
          regList: [],
          openText: '启用',
          closeText: '关闭',
          trigger: 'change',
        },
        disabled: false,
        'active-text': '',
        'inactive-text': '',
        'active-color': null,
        'inactive-color': null,
        'active-value': 1,
        'inactive-value': 0,
      }
    case 'single_select':
      return buildSelect(identity, field, false)
    case 'multi_select':
      return buildSelect(identity, field, true)
    case 'date':
      rejectUnexpectedOptions(field)
      return {
        ...identity,
        __config__: {
          ...identity.__config__,
          jdcloudKey: 'date',
          formulaConf: {},
          defaultValueType: 'custom',
          tagIcon: 'iconfont icon-date',
          defaultValue: null,
          regList: [],
          trigger: 'change',
          linkageQuery: {},
        },
        placeholder: '请选择',
        type: 'date',
        style: { width: '100%' },
        disabled: false,
        clearable: true,
        format: 'yyyy-MM-dd',
        'value-format': 'timestamp',
        'start-placeholder': '开始日期',
        'end-placeholder': '结束日期',
        readonly: false,
        fixedValue: '',
      }
    case 'time':
      rejectUnexpectedOptions(field)
      return {
        ...identity,
        __config__: {
          ...identity.__config__,
          jdcloudKey: 'time',
          tag: 'el-time-picker',
          tagIcon: 'iconfont icon-time',
          defaultValue: null,
          regList: [],
          trigger: 'change',
        },
        placeholder: '请选择',
        style: { width: '100%' },
        disabled: false,
        clearable: true,
        readonly: false,
        'picker-options': { selectableRange: '00:00:00-23:59:59' },
        format: 'HH:mm:ss',
        'value-format': 'HH:mm:ss',
      }
  }
}

/** Fields share the generator's layout, labeling, visibility, and identity metadata. */
function commonConfig(field: TableFieldInput, fieldId: number): Record<string, JsonValue> {
  return {
    label: field.label,
    labelWidth: null,
    showLabel: true,
    required: field.required,
    layout: 'colFormItem',
    span: 24,
    dragDisabled: false,
    visible: true,
    formId: fieldId,
    renderKey: fieldId,
  }
}

/** Build the generator's static select template with explicit stored option values. */
function buildSelect(
  identity: Record<string, JsonValue>,
  field: TableFieldInput,
  multiple: boolean,
): Record<string, JsonValue> {
  const options = requireOptions(field)
  return {
    ...identity,
    __config__: {
      ...(identity.__config__ as Record<string, JsonValue>),
      jdcloudKey: 'select',
      sortType: '',
      isBind: false,
      tag: 'el-select',
      tagIcon: 'iconfont icon-select',
      defaultValue: multiple ? [] : '',
      regList: [],
      selectList: [],
      trigger: 'change',
      dataType: 'static',
      linkageQuery: {},
      functionId: '',
      functionField: '',
      propsUrl: '',
      props: { label: 'fullName', value: 'id' },
    },
    __slot__: {
      options: options.map(option => ({ fullName: option.label, id: option.value, color: OPTION_COLOR })),
    },
    placeholder: '请选择',
    style: { width: '100%' },
    loading: false,
    clearable: true,
    disabled: false,
    filterable: true,
    multiple,
  }
}

/** Require non-empty, uniquely valued options for either select kind. */
function requireOptions(field: TableFieldInput): TableFieldOption[] {
  if (field.options === undefined || field.options.length === 0) {
    throw new TypeError(`JDCloud select field ${JSON.stringify(field.enCode)} requires options`)
  }
  const seen = new Set<string>()
  return field.options.map((option) => {
    const label = option.label.trim()
    const value = option.value.trim()
    if (label === '' || value === '') {
      throw new TypeError(`JDCloud select field ${JSON.stringify(field.enCode)} has an empty option`)
    }
    if (seen.has(value)) {
      throw new TypeError(`JDCloud select field ${JSON.stringify(field.enCode)} repeats option ${JSON.stringify(value)}`)
    }
    seen.add(value)
    return { label, value }
  })
}

/** Reject select-only option data on non-select fields. */
function rejectUnexpectedOptions(field: TableFieldInput): void {
  if (field.options !== undefined && field.options.length > 0) {
    throw new TypeError(`JDCloud field ${JSON.stringify(field.enCode)} accepts options only for select kinds`)
  }
}
