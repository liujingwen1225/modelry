import { useState } from 'react'
import { Button, Drawer, Field, Input, Notice, Select, Switch, Table } from '@/ui'
import type { TableColumnsType } from '@/ui'
import { PlusOutlined } from '@ant-design/icons'
import { collectionsApi, type CollectionSummary, type FieldInput, type FieldType } from '@/api/collections'
import { errorMessage } from '@/api/client'
import { useData } from './DataContext'

type FieldRow = { name: string; type: FieldType; required: boolean }

const FIELD_TYPES: Array<{ value: FieldType; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '是 / 否' },
  { value: 'dateTime', label: '日期时间' },
  { value: 'json', label: 'JSON' },
  { value: 'file', label: '文件' },
  { value: 'files', label: '多文件' },
]

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/**
 * 创建集合抽屉（Figma #20:16086）。
 *
 * 名称会直接成为 API 路径的一部分，因此按小写字母、数字和下划线校验；
 * 初始字段由用户定义，系统字段由后端自动补齐，这里不重复添加。
 */
export function CreateCollectionDrawer(props: {
  open: boolean
  onClose: () => void
  onCreated: (collection: CollectionSummary) => void
}) {
  const data = useData()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [rows, setRows] = useState<FieldRow[]>([{ name: 'title', type: 'text', required: true }])
  const [error, setError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setName('')
    setDescription('')
    setRows([{ name: 'title', type: 'text', required: true }])
    setError(null)
  }

  const nameTaken = data.collections.some((collection) => collection.name.toLowerCase() === name.trim().toLowerCase())
  const nameValid = NAME_PATTERN.test(name) && !nameTaken
  const fieldsValid = rows.every((row) => NAME_PATTERN.test(row.name)) && new Set(rows.map((row) => row.name)).size === rows.length

  const submit = async () => {
    if (!nameValid || !fieldsValid) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const fields: FieldInput[] = rows.map((row) => ({ name: row.name, type: row.type, required: row.required }))
      const collection = await collectionsApi.create({ name, description: description.trim() || undefined, fields })
      reset()
      props.onCreated({ ...collection, recordCount: 0 })
    } catch (cause) {
      setError(cause)
    } finally {
      setSaving(false)
    }
  }

  const columns: TableColumnsType<FieldRow> = [
    {
      title: '字段',
      dataIndex: 'name',
      render: (_value, _row, index) => (
        <Input
          className="mr-mono"
          value={rows[index]?.name}
          placeholder="field_name"
          aria-label={`字段 ${index + 1} 名称`}
          onChange={(event) => {
            const next = [...rows]
            next[index] = { ...next[index]!, name: event.target.value }
            setRows(next)
          }}
        />
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 132,
      render: (_value, _row, index) => (
        <Select
          value={rows[index]?.type}
          options={FIELD_TYPES}
          aria-label={`字段 ${index + 1} 类型`}
          onChange={(value: FieldType) => {
            const next = [...rows]
            next[index] = { ...next[index]!, type: value }
            setRows(next)
          }}
        />
      ),
    },
    {
      title: '必填',
      dataIndex: 'required',
      width: 62,
      render: (_value, _row, index) => (
        <Switch
          size="small"
          checked={rows[index]?.required}
          aria-label={`字段 ${index + 1} 是否必填`}
          onChange={(checked) => {
            const next = [...rows]
            next[index] = { ...next[index]!, required: checked }
            setRows(next)
          }}
        />
      ),
    },
    {
      title: '',
      width: 44,
      render: (_value, _row, index) => (
        <Button type="text" size="small" onClick={() => setRows(rows.filter((_, position) => position !== index))}>
          移除
        </Button>
      ),
    },
  ]

  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      width={480}
      rootClassName="mr-drawer"
      title={
        <div className="mr-drawer__title">
          <span className="mr-drawer__heading">创建集合</span>
          <span className="mr-drawer__subtitle">新增一种应用数据，不会修改现有集合。</span>
        </div>
      }
      footer={
        <div className="mr-drawer__footer">
          <span className="mr-meta">尚未创建</span>
          <div className="mr-drawer__actions">
            <Button onClick={props.onClose}>取消</Button>
            <Button type="primary" loading={saving} disabled={!nameValid || !fieldsValid} onClick={() => void submit()}>
              创建集合
            </Button>
          </div>
        </div>
      }
    >
      <Field label="集合名称" required>
        <Input
          className="mr-mono"
          value={name}
          placeholder="reading_lists"
          autoFocus
          onChange={(event) => setName(event.target.value.toLowerCase())}
        />
      </Field>
      <p className="mr-drawer__hint">使用小写字母、数字和下划线；将用于 API 路径。</p>

      {name.length > 0 ? (
        nameTaken ? (
          <p className="mr-drawer__check mr-drawer__check--error">✕ 已有同名集合，换一个名称</p>
        ) : NAME_PATTERN.test(name) ? (
          <p className="mr-drawer__check">✓ 名称可用</p>
        ) : (
          <p className="mr-drawer__check mr-drawer__check--error">✕ 需以小写字母开头，仅含小写字母、数字和下划线</p>
        )
      ) : null}

      <Field label="说明">
        <Input value={description} placeholder="想读、在读和读过的书单" onChange={(event) => setDescription(event.target.value)} />
      </Field>

      <h3 className="mr-drawer__section">初始字段</h3>
      <Table<FieldRow>
        rowKey={(_row, index) => String(index)}
        size="small"
        pagination={false}
        columns={columns}
        dataSource={rows}
        className="mr-drawer__table"
      />

      <Button icon={<PlusOutlined />} onClick={() => setRows([...rows, { name: '', type: 'text', required: false }])}>
        添加字段
      </Button>
      <p className="mr-drawer__hint">自动包含 id、created_at 与 updated_at，无需手动添加。</p>

      <Notice>默认私人：仅作者可读取、修改和删除；创建需要登录，owner 为本人。</Notice>

      {error ? <Notice tone="danger">{errorMessage(error)}</Notice> : null}

      <p className="mr-drawer__note">先用默认配置开始，创建后可在「结构」中继续调整。</p>
    </Drawer>
  )
}
