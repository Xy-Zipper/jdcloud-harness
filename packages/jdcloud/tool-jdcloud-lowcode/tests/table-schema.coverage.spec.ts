import { describe, expect, it } from 'vitest'
import { buildFormData } from '../src/table-schema.ts'
import type { TableFieldInput } from '../src/table-schema.ts'

/** Read one generated field as a JSON object for focused component assertions. */
function generatedFields(form: ReturnType<typeof buildFormData>): Array<Record<string, unknown>> {
  return form.fields as Array<Record<string, unknown>>
}

describe('table schema component coverage', () => {
  it('builds all eight supported component kinds with stable identities', () => {
    const inputs: TableFieldInput[] = [
      { enCode: ' title ', label: ' Title ', kind: 'text', required: true, options: [] },
      { enCode: 'notes', label: 'Notes', kind: 'textarea', required: false },
      { enCode: 'amount', label: 'Amount', kind: 'number', required: false },
      { enCode: 'enabled', label: 'Enabled', kind: 'switch', required: false },
      {
        enCode: 'status',
        label: 'Status',
        kind: 'single_select',
        required: true,
        options: [{ label: ' Open ', value: ' open ' }],
      },
      {
        enCode: 'tags',
        label: 'Tags',
        kind: 'multi_select',
        required: false,
        options: [{ label: 'Tag', value: 'tag' }],
      },
      { enCode: 'day', label: 'Day', kind: 'date', required: true },
      { enCode: 'at', label: 'At', kind: 'time', required: false },
    ]
    const form = buildFormData(inputs)
    const fields = generatedFields(form)

    expect(form).toMatchObject({
      formRef: 'elForm',
      category: 'Web',
      formModel: 'dataForm',
      idGlobal: 108,
      fields,
    })
    expect(fields.map((field) => {
      const config = field.__config__ as Record<string, unknown>
      return [field.__vModel__, config.label, config.jdcloudKey, config.formId, config.renderKey]
    })).toEqual([
      ['title', 'Title', 'comInput', 101, 101],
      ['notes', 'Notes', 'textarea', 102, 102],
      ['amount', 'Amount', 'numInput', 103, 103],
      ['enabled', 'Enabled', 'switch', 104, 104],
      ['status', 'Status', 'select', 105, 105],
      ['tags', 'Tags', 'select', 106, 106],
      ['day', 'Day', 'date', 107, 107],
      ['at', 'At', 'time', 108, 108],
    ])
    expect(fields[1]).toMatchObject({ type: 'textarea', autosize: { minRows: 4, maxRows: 4 } })
    expect(fields[4]).toMatchObject({
      multiple: false,
      __config__: { defaultValue: '' },
      __slot__: { options: [{ fullName: 'Open', id: 'open', color: '#46c26f' }] },
    })
    expect(fields[5]).toMatchObject({
      multiple: true,
      __config__: { defaultValue: [] },
      __slot__: { options: [{ fullName: 'Tag', id: 'tag', color: '#46c26f' }] },
    })
    expect(fields[7]).toMatchObject({
      format: 'HH:mm:ss',
      'value-format': 'HH:mm:ss',
      'picker-options': { selectableRange: '00:00:00-23:59:59' },
    })
  })
})

describe('table schema validation coverage', () => {
  it('rejects empty fields, invalid or duplicate codes, and blank labels', () => {
    expect(() => buildFormData([])).toThrow('requires at least one field')
    expect(() => buildFormData([
      { enCode: '1bad', label: 'Bad', kind: 'text', required: false },
    ])).toThrow('field code "1bad" is invalid')
    expect(() => buildFormData([
      { enCode: 'same', label: 'First', kind: 'text', required: false },
      { enCode: ' same ', label: 'Second', kind: 'text', required: false },
    ])).toThrow('field code "same" is duplicated')
    expect(() => buildFormData([
      { enCode: 'emptyLabel', label: ' ', kind: 'text', required: false },
    ])).toThrow('field "emptyLabel" requires a label')
  })

  it('requires options for selects and rejects empty or duplicate option values', () => {
    expect(() => buildFormData([
      { enCode: 'status', label: 'Status', kind: 'single_select', required: false },
    ])).toThrow('select field "status" requires options')
    expect(() => buildFormData([
      { enCode: 'status', label: 'Status', kind: 'multi_select', required: false, options: [] },
    ])).toThrow('select field "status" requires options')
    expect(() => buildFormData([{
      enCode: 'status',
      label: 'Status',
      kind: 'single_select',
      required: false,
      options: [{ label: ' ', value: 'open' }],
    }])).toThrow('select field "status" has an empty option')
    expect(() => buildFormData([{
      enCode: 'status',
      label: 'Status',
      kind: 'single_select',
      required: false,
      options: [{ label: 'Open', value: ' ' }],
    }])).toThrow('select field "status" has an empty option')
    expect(() => buildFormData([{
      enCode: 'status',
      label: 'Status',
      kind: 'single_select',
      required: false,
      options: [{ label: 'Open', value: 'open' }, { label: 'Again', value: ' open ' }],
    }])).toThrow('select field "status" repeats option "open"')
  })

  it('rejects non-empty select options on non-select fields', () => {
    expect(() => buildFormData([{
      enCode: 'title',
      label: 'Title',
      kind: 'text',
      required: false,
      options: [{ label: 'Unexpected', value: 'unexpected' }],
    }])).toThrow('accepts options only for select kinds')
  })
})
