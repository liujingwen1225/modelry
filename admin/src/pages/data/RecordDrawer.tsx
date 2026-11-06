import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Drawer, Field, Input, InputNumber, Notice, Select, Switch, Upload } from '@/ui'
import { UploadOutlined } from '@ant-design/icons'
import type { Field as SchemaField, Collection } from '@/api/collections'
import { collectionsApi, collectionKeys, isMultipleRelation } from '@/api/collections'
import { recordsApi, type RecordItem } from '@/api/records'
import { errorMessage } from '@/api/client'
import { recordTitle } from './record-format'

/**
 * 记录编辑抽屉（Figma「数据 · 编辑笔记记录」）。
 *
 * 表单由集合结构驱动：字段类型决定控件，关系字段列出目标集合的真实记录，
 * 文件字段先上传再写入 Runtime 生成的存储引用，不使用假进度。
 */
export function RecordDrawer(props: {
  open: boolean
  collection: Collection
  record?: RecordItem
  onClose: () => void
  onSaved: (record: RecordItem) => void
}) {
  const editable = useMemo(() => props.collection.fields.filter((field) => !field.system), [props.collection.fields])
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!props.open) {
      return
    }
    const initial: Record<string, unknown> = {}
    for (const field of editable) {
      initial[field.name] = props.record?.[field.name] ?? (field.type === 'boolean' ? false : undefined)
    }
    setValues(initial)
    setError(null)
  }, [props.open, props.record, editable])

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = {}
      for (const field of editable) {
        const value = values[field.name]
        if (value === undefined || value === '') {
          continue
        }
        payload[field.name] = value
      }
      const saved = props.record
        ? await recordsApi.update(props.collection.id, props.record.id, payload)
        : await recordsApi.create(props.collection.id, payload)
      props.onSaved(saved)
    } catch (cause) {
      setError(cause)
    } finally {
      setSaving(false)
    }
  }

  const setValue = (name: string, value: unknown) => setValues((current) => ({ ...current, [name]: value }))

  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      width={480}
      rootClassName="mr-drawer"
      title={
        <div className="mr-drawer__title">
          <span className="mr-drawer__heading">{props.record ? '编辑记录' : '新增记录'}</span>
          <span className="mr-drawer__subtitle">{props.collection.name} · 只保存你填写的字段</span>
        </div>
      }
      footer={
        <div className="mr-drawer__footer">
          <span className="mr-meta">{props.record ? `id · ${props.record.id}` : '尚未创建'}</span>
          <div className="mr-drawer__actions">
            <Button onClick={props.onClose}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void submit()}>
              {props.record ? '保存' : '创建记录'}
            </Button>
          </div>
        </div>
      }
    >
      {editable.map((field) => (
        <Field key={field.id} label={field.name} required={field.required} hint={field.description}>
          <FieldInput field={field} value={values[field.name]} onChange={(value) => setValue(field.name, value)} collectionId={props.collection.id} />
        </Field>
      ))}

      {error ? <Notice tone="danger">{errorMessage(error)}</Notice> : null}
    </Drawer>
  )
}

function FieldInput(props: {
  field: SchemaField
  value: unknown
  onChange: (value: unknown) => void
  collectionId: string
}) {
  const { field } = props
  switch (field.type) {
    case 'boolean':
      return <Switch checked={Boolean(props.value)} onChange={(checked) => props.onChange(checked)} />
    case 'number':
      return (
        <InputNumber
          className="mr-full-width"
          value={typeof props.value === 'number' ? props.value : undefined}
          onChange={(value) => props.onChange(value)}
        />
      )
    case 'json':
      return (
        <Input.TextArea
          className="mr-mono"
          rows={4}
          value={typeof props.value === 'string' ? props.value : props.value ? JSON.stringify(props.value, null, 2) : ''}
          placeholder='{"key": "value"}'
          onChange={(event) => props.onChange(event.target.value)}
        />
      )
    case 'dateTime':
      return (
        <Input
          className="mr-mono"
          value={typeof props.value === 'string' ? props.value : ''}
          placeholder="2026-11-03T10:36:12Z"
          onChange={(event) => props.onChange(event.target.value)}
        />
      )
    case 'relation':
      return <RelationSelect field={field} value={props.value} onChange={props.onChange} />
    case 'file':
    case 'files':
      return <FileField field={field} value={props.value} onChange={props.onChange} collectionId={props.collectionId} />
    case 'text':
    default:
      return (
        <Input.TextArea
          rows={props.field.name === 'content' || props.field.name === 'description' ? 5 : 2}
          value={typeof props.value === 'string' ? props.value : ''}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )
  }
}

/** 关系字段：下拉列出目标集合的真实记录，显示其标题字段。 */
function RelationSelect(props: { field: SchemaField; value: unknown; onChange: (value: unknown) => void }) {
  const targetId = props.field.relation?.targetCollectionId ?? ''
  const multiple = isMultipleRelation(props.field.relation)

  const target = useQuery({
    queryKey: collectionKeys.detail(targetId),
    queryFn: () => collectionsApi.get(targetId),
    enabled: Boolean(targetId),
  })
  const records = useQuery({
    queryKey: ['relation-options', targetId],
    queryFn: () => recordsApi.list(targetId, { limit: 100 }),
    enabled: Boolean(targetId),
  })

  const options = (records.data?.data ?? []).map((record) => ({
    value: record.id,
    label: target.data ? recordTitle(target.data.fields, record, record.id) : record.id,
  }))

  return (
    <Select
      mode={multiple ? 'multiple' : undefined}
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder={target.data ? `${target.data.name} · 选择记录` : '选择关联记录'}
      loading={records.isPending}
      options={options}
      value={(multiple ? (Array.isArray(props.value) ? props.value : []) : (props.value as string)) ?? undefined}
      onChange={(value) => props.onChange(value)}
    />
  )
}

/** 文件字段：上传成功后才写入存储引用；失败保留错误，不伪装进度。 */
function FileField(props: { field: SchemaField; value: unknown; onChange: (value: unknown) => void; collectionId: string }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const multiple = props.field.type === 'files'
  const keys = multiple ? (Array.isArray(props.value) ? (props.value as string[]) : []) : props.value ? [String(props.value)] : []

  const upload = async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      const result = await recordsApi.uploadFile(props.collectionId, props.field.name, file)
      const key = result.data.temporaryId
      props.onChange(multiple ? [...keys, key] : key)
    } catch (cause) {
      setError(cause)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="mr-file-field">
      <Upload
        showUploadList={false}
        multiple={multiple}
        beforeUpload={(file) => {
          void upload(file as File)
          return false
        }}
      >
        <Button icon={<UploadOutlined />} loading={uploading}>
          {uploading ? '正在上传…' : multiple ? '添加文件' : '选择文件'}
        </Button>
      </Upload>
      {keys.length > 0 ? (
        <ul className="mr-file-field__list">
          {keys.map((key, index) => (
            <li key={key}>
              <span className="mr-mono">{key}</span>
              <Button
                type="link"
                size="small"
                onClick={() => props.onChange(multiple ? keys.filter((_item, position) => position !== index) : undefined)}
              >
                移除
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Notice tone="danger">{errorMessage(error)}</Notice> : null}
    </div>
  )
}
