import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Drawer, Field, Input, Notice, Select, Switch, Table } from '@/ui'
import type { TableColumnsType } from '@/ui'
import {
  collectionsApi,
  collectionKeys,
  isMultipleRelation,
  type Collection,
  type Field as SchemaField,
  type FieldInput,
  type FieldType,
} from '@/api/collections'
import { errorMessage } from '@/api/client'
import { FIELD_TYPE_LABELS } from './record-format'

const CREATE_TYPES: Array<{ value: FieldType; label: string }> = (
  ['text', 'number', 'boolean', 'dateTime', 'json', 'file', 'files', 'relation'] as FieldType[]
).map((value) => ({ value, label: FIELD_TYPE_LABELS[value] }))

/**
 * 结构工作面（Figma「数据 · notes 结构」）。
 *
 * 字段改动不会立即写入结构：先保存为待应用变更，由用户确认后应用，
 * 应用历史与失败状态由后端变更生命周期维护。
 */
export function SchemaTab(props: { collection: Collection }) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<SchemaField | undefined>(undefined)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  // 标题栏的「添加字段」通过 ?add=1 打开抽屉，关闭后清掉参数。
  useEffect(() => {
    if (searchParams.get('add') === '1') {
      setEditing(undefined)
      setDrawerOpen(true)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const fields = props.collection.fields
  const custom = fields.filter((field) => !field.system)
  const system = fields.filter((field) => field.system)

  const columns: TableColumnsType<SchemaField> = [
    {
      title: '字段',
      dataIndex: 'name',
      width: 170,
      render: (value: string, field) => (
        <span className="mr-mono">
          {value}
          {field.system ? ' ·' : ''}
        </span>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 150,
      render: (type: FieldType, field) =>
        field.system
          ? `系统 · ${FIELD_TYPE_LABELS[type] ?? type}`
          : field.type === 'relation'
            ? `关联 · ${isMultipleRelation(field.relation) ? '多选' : '单选'}`
            : FIELD_TYPE_LABELS[type],
    },
    { title: '必填', dataIndex: 'required', width: 70, render: (value: boolean) => (value ? '是' : '否') },
    {
      title: '说明 / 关联',
      dataIndex: 'description',
      render: (_value, field) =>
        field.description ??
          (field.relation
            ? `${field.relation.targetCollectionId} · ${isMultipleRelation(field.relation) ? '多个' : '单条'}`
            : '—'),
    },
    {
      title: '',
      width: 156,
      render: (_value, field) =>
        field.system ? (
          <span className="mr-meta">锁定</span>
        ) : (
          <span className="mr-schema__row-actions">
            {field.type === 'file' || field.type === 'files' ? (
              <Button
                type="link"
                size="small"
                onClick={() => navigate(`/data/${props.collection.id}/schema?field=${encodeURIComponent(field.id)}`)}
              >
                配置文件
              </Button>
            ) : null}
            <Button type="link" size="small" onClick={() => { setEditing(field); setDrawerOpen(true) }}>
              编辑
            </Button>
          </span>
        ),
    },
  ]

  return (
    <>
      <div className="mr-schema">
        <div className="mr-schema__head">
          <span>字段 · {fields.length}</span>
          <span className="mr-meta">
            {custom.length} 个自定义字段 · {system.length} 个系统字段
          </span>
        </div>

        <Table<SchemaField>
          rowKey="id"
          size="small"
          pagination={false}
          columns={columns}
          dataSource={fields}
          className="mr-schema__table"
        />

        <p className="mr-muted-note">系统字段记录 ID 与时间戳，不能删除；自定义字段的改动会先进入待应用变更。</p>

        <div className="mr-divider-line" />

        <div className="mr-schema__section">
          <h2 className="mr-schema__title">索引</h2>
          <p className="mr-muted-note">索引帮助常用查询更快找到记录，不改变谁可以访问。</p>
          {props.collection.indexes && props.collection.indexes.length > 0 ? (
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={props.collection.indexes}
              columns={[
                { title: '索引名称', dataIndex: 'name', render: (value: string) => <span className="mr-mono">{value}</span> },
                { title: '字段', dataIndex: 'fields', render: (value?: string[]) => <span className="mr-mono">{value?.join(' · ') ?? '—'}</span> },
                { title: '方式', dataIndex: 'unique', width: 120, render: (value?: boolean) => (value ? '唯一索引' : '普通索引') },
              ]}
            />
          ) : (
            <p className="mr-muted-note">还没有额外索引。</p>
          )}
        </div>
      </div>

      <FieldDrawer
        open={drawerOpen}
        collection={props.collection}
        field={editing}
        onClose={() => setDrawerOpen(false)}
      />
    </>
  )
}

/** 字段抽屉：同时承担新增、编辑与移除，改动统一进入待应用变更。 */
function FieldDrawer(props: { open: boolean; collection: Collection; field?: SchemaField; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [type, setType] = useState<FieldType>('text')
  const [required, setRequired] = useState(false)
  const [description, setDescription] = useState('')
  const [target, setTarget] = useState<string>('')
  const [multiple, setMultiple] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)

  const collections = useQuery({ queryKey: collectionKeys.list, queryFn: collectionsApi.list })

  // 打开抽屉时用当前字段初始化；新增时清空。
  useEffect(() => {
    if (!props.open) {
      return
    }
    setName(props.field?.name ?? '')
    setType(props.field?.type ?? 'text')
    setRequired(Boolean(props.field?.required))
    setDescription(props.field?.description ?? '')
    setTarget(props.field?.relation?.targetCollectionId ?? '')
    setMultiple(isMultipleRelation(props.field?.relation))
    setError(null)
  }, [props.open, props.field])

  const relationInvalid = type === 'relation' && !target

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const definition: FieldInput = { name, type, required, description: description || undefined }
      if (type === 'relation') {
        definition.relation = {
          targetCollectionId: target,
          cardinality: multiple ? 'many-to-many' : 'many-to-one',
        }
      }
      // 后端要求 relation 字段使用 relation 操作，普通字段使用 field 操作。
      await collectionsApi.addOperation(props.collection.id, {
        kind: type === 'relation' ? 'relation' : 'field',
        action: props.field ? 'update' : 'add',
        targetId: props.field?.id,
        definition,
      })
      await queryClient.invalidateQueries({ queryKey: collectionKeys.pending(props.collection.id) })
      props.onClose()
    } catch (cause) {
      setError(cause)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!props.field) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await collectionsApi.addOperation(props.collection.id, {
        kind: 'field',
        action: 'remove',
        targetId: props.field.id,
        definition: { name: props.field.name },
      })
      await queryClient.invalidateQueries({ queryKey: collectionKeys.pending(props.collection.id) })
      props.onClose()
    } catch (cause) {
      setError(cause)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      width={480}
      rootClassName="mr-drawer"
      title={
        <div className="mr-drawer__title">
          <span className="mr-drawer__heading">{props.field ? `编辑字段 · ${props.field.name}` : '添加字段'}</span>
          <span className="mr-drawer__subtitle">改动先进入待应用变更，应用后才会写入结构。</span>
        </div>
      }
      footer={
        <div className="mr-drawer__footer">
          <span className="mr-meta">待应用变更</span>
          <div className="mr-drawer__actions">
            {props.field ? (
              <Button danger onClick={() => void remove()} loading={saving}>
                移除字段
              </Button>
            ) : null}
            <Button onClick={props.onClose}>取消</Button>
            <Button type="primary" loading={saving} disabled={!name || relationInvalid} onClick={() => void submit()}>
              保存到待应用变更
            </Button>
          </div>
        </div>
      }
    >
      <Field label="字段名称" required>
        <Input className="mr-mono" value={name} placeholder="reading_status" onChange={(event) => setName(event.target.value)} disabled={Boolean(props.field)} />
      </Field>

      <Field label="类型">
        <Select value={type} options={CREATE_TYPES} onChange={(value: FieldType) => setType(value)} />
      </Field>

      {type === 'relation' ? (
        <>
          <Field label="关联到" required>
            <Select
              value={target || undefined}
              placeholder="选择目标集合"
              options={(collections.data ?? [])
                .filter((collection) => collection.id !== props.collection.id)
                .map((collection) => ({ value: collection.id, label: collection.name }))}
              onChange={(value: string) => setTarget(value)}
            />
          </Field>
          <Field label="关系数量">
            <Select
              value={multiple ? 'many' : 'one'}
              options={[
                { value: 'one', label: '一条记录' },
                { value: 'many', label: '多条记录' },
              ]}
              onChange={(value: string) => setMultiple(value === 'many')}
            />
          </Field>
        </>
      ) : null}

      <Field label="说明">
        <Input value={description} placeholder="这个字段记录什么" onChange={(event) => setDescription(event.target.value)} />
      </Field>

      <div className="mr-drawer__inline">
        <span>必填</span>
        <Switch checked={required} onChange={setRequired} />
      </div>

      {type === 'file' || type === 'files' ? (
        <Notice>文件字段由记录内上传，Runtime 保存对象并返回存储引用；不会把文件内容放进 SQLite。</Notice>
      ) : null}

      {error ? <Notice tone="danger">{errorMessage(error)}</Notice> : null}
    </Drawer>
  )
}
