import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { App, Button, Input, InputNumber, Notice, Select, Table } from '@/ui'
import type { TableColumnsType } from '@/ui'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { collectionKeys, collectionsApi, type Collection, type Field as SchemaField } from '@/api/collections'
import { errorMessage } from '@/api/client'
import './file-field.css'

/** 允许的 MIME 条目与后端 NormalizeMIMETypes 一致，最多 16 项。 */
const MIME_OPTIONS = [
  { value: 'application/pdf', label: 'PDF' },
  { value: 'text/plain', label: 'TXT / MD' },
  { value: 'text/csv', label: 'CSV' },
  { value: 'application/gpx+xml', label: 'GPX' },
  { value: 'image/png', label: 'PNG' },
  { value: 'image/jpeg', label: 'JPEG' },
  { value: 'image/webp', label: 'WebP' },
  { value: 'image/gif', label: 'GIF' },
]

const DEFAULT_MIME = ['application/pdf', 'text/plain', 'text/csv', 'application/gpx+xml']
const DEFAULT_MAX_BYTES = 10 << 20
const DEFAULT_MAX_FILES = 5

type Row = {
  key: string
  label: string
  example: string
  description: string
  control: ReactNode
}

type FileValidation = {
  maxBytes?: number
  maxFiles?: number
  allowedMimeTypes?: string[]
}

function readValidation(field: SchemaField): FileValidation {
  if (!field.validation || typeof field.validation !== 'object') return {}
  return field.validation as FileValidation
}

/**
 * Figma「数据 · 文件字段配置」（画板 11）。
 *
 * 文件是 Collection 的字段，不是独立的资源管理页面。这里的约束写入
 * 后端 Field.validation，经待应用变更保存、应用后由上传链路真实校验。
 */
export function FileFieldConfig(props: { collection: Collection; field: SchemaField }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const initial = readValidation(props.field)

  const [mimeTypes, setMimeTypes] = useState<string[]>(initial.allowedMimeTypes ?? DEFAULT_MIME)
  const [maxFiles, setMaxFiles] = useState<number>(initial.maxFiles ?? DEFAULT_MAX_FILES)
  const [maxMegabytes, setMaxMegabytes] = useState<number>(Math.max(1, Math.round((initial.maxBytes ?? DEFAULT_MAX_BYTES) / (1 << 20))))
  const [description, setDescription] = useState(props.field.description ?? '')
  const isMultiple = props.field.type === 'files'

  useEffect(() => {
    const next = readValidation(props.field)
    setMimeTypes(next.allowedMimeTypes ?? DEFAULT_MIME)
    setMaxFiles(next.maxFiles ?? DEFAULT_MAX_FILES)
    setMaxMegabytes(Math.max(1, Math.round((next.maxBytes ?? DEFAULT_MAX_BYTES) / (1 << 20))))
    setDescription(props.field.description ?? '')
  }, [props.field])

  const save = useMutation({
    mutationFn: () => {
      const validation: FileValidation = { maxBytes: maxMegabytes * (1 << 20), allowedMimeTypes: mimeTypes }
      if (isMultiple) validation.maxFiles = maxFiles
      // 后端用整份 Field 定义替换目标字段，因此必须带回原有身份与关系信息。
      const definition = {
        ...props.field,
        description: description || undefined,
        validation,
      }
      return collectionsApi.addOperation(props.collection.id, {
        kind: 'field',
        action: 'update',
        targetId: props.field.id,
        definition,
      })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: collectionKeys.pending(props.collection.id) }),
        queryClient.invalidateQueries({ queryKey: collectionKeys.detail(props.collection.id) }),
      ])
      message.success('配置已保存为待应用变更；请在结构页应用后生效，上传时才会按新约束校验。')
      navigate(`/data/${props.collection.id}/schema`)
    },
  })

  const rows: Row[] = [
    {
      key: 'name',
      label: '字段名称',
      example: '—',
      description: '保存在记录中的文件列表，用于笔记附件。',
      control: <span className="mr-mono">{props.field.name}</span>,
    },
    {
      key: 'type',
      label: '字段类型',
      example: '—',
      description: '文件字段用于存储与记录关联的附件，文件内容保存在 Runtime 对象存储中。',
      control: <span>{isMultiple ? '文件（多个）' : '文件（单个）'}</span>,
    },
    {
      key: 'mime',
      label: '文件类型',
      example: 'PDF、TXT',
      description: '限制上传文件的格式，避免混入不相关附件。',
      control: (
        <Select
          mode="multiple"
          aria-label="文件类型"
          value={mimeTypes}
          options={MIME_OPTIONS}
          maxTagCount="responsive"
          onChange={(value: string[]) => setMimeTypes(value)}
          className="mr-file-field__select"
        />
      ),
    },
    {
      key: 'count',
      label: '数量限制',
      example: '1 ~ 3',
      description: '控制单条记录最多关联多少个附件。',
      control: isMultiple ? (
        <InputNumber aria-label="数量限制" min={1} max={32} value={maxFiles} onChange={(value) => setMaxFiles(value ?? 1)} />
      ) : (
        <span>1 个文件（单文件字段）</span>
      ),
    },
    {
      key: 'size',
      label: '单文件大小',
      example: '5 MB',
      description: '限制单个文件大小，上传时会按此配置校验。',
      control: (
        <InputNumber
          aria-label="单文件大小（MB）"
          min={1}
          max={128}
          value={maxMegabytes}
          onChange={(value) => setMaxMegabytes(value ?? 1)}
          addonAfter="MB"
        />
      ),
    },
    {
      key: 'description',
      label: '字段说明',
      example: '—',
      description: '用于提示用户此字段的用途，方便理解字段。',
      control: (
        <Input aria-label="字段说明" value={description} placeholder="附于记录的附件" onChange={(event) => setDescription(event.target.value)} />
      ),
    },
  ]

  const columns: TableColumnsType<Row> = [
    { title: '配置项', dataIndex: 'label', width: 150, render: (value: string) => <span className="mr-mono">{value}</span> },
    { title: '值', key: 'value', width: 230, render: (_value, row) => row.control },
    { title: '示例', dataIndex: 'example', width: 120, render: (value: string) => <span className="mr-file-field__example">{value}</span> },
    { title: '说明', dataIndex: 'description', render: (value: string) => <span className="mr-file-field__description">{value}</span> },
  ]

  return (
    <div className="mr-page mr-file-field">
      <div className="mr-file-field__back">
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate(`/data/${props.collection.id}/schema`)}>
          返回结构
        </Button>
      </div>

      <header className="mr-file-field__head">
        <div>
          <h1 className="mr-overview__title">数据 · 文件字段配置</h1>
          <p className="mr-overview__lede">
            编辑 {props.collection.name} 集合中的 {props.field.name} 字段，定义文件类型、数量、大小限制，以及字段说明。
          </p>
        </div>
        <Button
          type="primary"
          loading={save.isPending}
          disabled={mimeTypes.length === 0 || maxMegabytes < 1 || (isMultiple && maxFiles < 1)}
          onClick={() => save.mutate()}
        >
          保存配置
        </Button>
      </header>

      <div className="mr-file-field__meta">
        <span className="mr-file-field__meta-name">
          {props.field.name} · 文件字段
        </span>
        <span>{props.collection.name} 集合 · schema v{props.collection.schemaVersion}</span>
      </div>

      <Table<Row>
        rowKey="key"
        className="mr-file-field__table"
        columns={columns}
        dataSource={rows}
        pagination={false}
        size="small"
      />

      <div className="mr-file-field__notes">
        <section>
          <h2>文件归属记录</h2>
          <p>
            {props.field.name} 是 {props.collection.name} 集合的字段类型，表示一条记录可以关联哪些附件。
            上传、预览、移除操作发生在记录编辑中，而不是独立资源管理。
          </p>
        </section>
        <section>
          <h2>访问范围与删除影响</h2>
          <p>
            文件属于记录的 {props.field.name} 字段。移除文件或删除字段前，请先在结构页查看待应用变更的差异与风险。
          </p>
        </section>
      </div>

      <Notice tone="warning">
        保存后不会立即写入结构。请在「结构」标签审阅并应用变更；应用后上传与记录写入才会按新的约束校验。
      </Notice>

      {save.isError ? <Notice tone="danger">保存失败：{errorMessage(save.error)}</Notice> : null}
    </div>
  )
}
