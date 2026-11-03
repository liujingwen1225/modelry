import type { ReactNode } from 'react'
import { Mono, StatusTag } from '@/ui'
import type { Field, FieldType } from '@/api/collections'
import { formatDateTime } from '@/lib/format'

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: '文本',
  number: '数字',
  boolean: '是 / 否',
  dateTime: '日期时间',
  json: 'JSON',
  relation: '关联',
  file: '文件',
  files: '多文件',
}

export function isFileField(field: Field): boolean {
  return field.type === 'file' || field.type === 'files'
}

/** 技术字段（记录 ID、时间戳）用等宽字体，业务值用正文。 */
export function isTechnicalField(field: Field): boolean {
  return field.type === 'dateTime' || field.type === 'json' || field.type === 'number'
}

export function displayValue(field: Field, value: unknown): ReactNode {
  if (value === undefined || value === null || value === '') {
    return <span className="mr-value-empty">未填写</span>
  }
  switch (field.type) {
    case 'boolean':
      return <StatusTag tone={value ? 'success' : 'neutral'}>{value ? '是' : '否'}</StatusTag>
    case 'dateTime':
      return <Mono>{formatDateTime(String(value))}</Mono>
    case 'json':
      return <Mono>{JSON.stringify(value)}</Mono>
    case 'number':
      return <Mono>{String(value)}</Mono>
    case 'relation': {
      const items = Array.isArray(value) ? value : [value]
      return (
        <span className="mr-relation-values">
          {items.map((item, index) => (
            <StatusTag key={index} tone="neutral">
              {typeof item === 'string' ? item : String((item as { id?: string })?.id ?? item)}
            </StatusTag>
          ))}
        </span>
      )
    }
    case 'file':
      return <Mono>{String(value)}</Mono>
    case 'files': {
      const items = Array.isArray(value) ? value : [value]
      return <Mono>{items.map((item) => String(item)).join(' · ')}</Mono>
    }
    default:
      return <span className="mr-value-text">{String(value)}</span>
  }
}

/** 记录标题：取第一个文本字段的值，空则退回 ID。 */
export function recordTitle(fields: Field[], values: Record<string, unknown>, recordId: string): string {
  const textField = fields.find((field) => field.type === 'text' && !field.system)
  const value = textField ? values[textField.name] : undefined
  return typeof value === 'string' && value.trim() !== '' ? value : recordId
}

/** 记录摘要：取第二个文本字段的前一段，用于表格副标题。 */
export function recordSnippet(fields: Field[], values: Record<string, unknown>): string {
  const textFields = fields.filter((field) => field.type === 'text' && !field.system)
  const second = textFields[1]
  const value = second ? values[second.name] : undefined
  if (typeof value !== 'string') {
    return ''
  }
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized
}
