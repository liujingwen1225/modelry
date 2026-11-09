import { Button, Mono, StatusTag } from '@/ui'
import { ArrowRightOutlined, CloseOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { Collection } from '@/api/collections'
import type { RecordItem } from '@/api/records'
import { formatDateTime } from '@/lib/format'
import { displayValue, recordTitle } from './record-format'

/**
 * 记录详情（Figma「数据 · notes 工作台」右侧详情栏，332px）。
 *
 * 展示的是这条记录的真实值，字段顺序与集合结构一致；
 * 技术字段使用等宽字体，关系与文件字段按各自语义呈现。
 */
export function RecordDetail(props: {
  collection: Collection
  record: RecordItem
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const navigate = useNavigate()
  const fields = props.collection.fields
  const title = recordTitle(fields, props.record, props.record.id)

  return (
    <aside className="mr-detail" aria-label="记录详情">
      <div className="mr-detail__head">
        <span className="mr-detail__eyebrow">记录详情</span>
        <div className="mr-detail__head-actions">
          <Button type="text" size="small" icon={<EditOutlined />} aria-label="编辑记录" onClick={props.onEdit} />
          <Button type="text" size="small" icon={<DeleteOutlined />} aria-label="删除记录" onClick={props.onDelete} />
          <Button type="text" size="small" icon={<CloseOutlined />} aria-label="关闭详情" onClick={props.onClose} />
        </div>
      </div>

      <div className="mr-detail__title">
        <h2 className="mr-detail__heading">{title}</h2>
        <Mono className="mr-detail__id">id · {props.record.id}</Mono>
      </div>

      <div className="mr-divider-line" />

      <dl className="mr-detail__fields">
        {fields
          .filter((field) => !field.system)
          .map((field) => (
            <div className="mr-detail__field" key={field.id}>
              <dt>{field.name}</dt>
              <dd>{displayValue(field, props.record[field.name])}</dd>
            </div>
          ))}
        <div className="mr-detail__field">
          <dt>created_at</dt>
          <dd>
            <Mono>{formatDateTime(props.record.createdAt)}</Mono>
          </dd>
        </div>
        <div className="mr-detail__field">
          <dt>updated_at</dt>
          <dd>
            <Mono>{formatDateTime(props.record.updatedAt)}</Mono>
          </dd>
        </div>
      </dl>

      <div className="mr-divider-line" />

      <div className="mr-detail__links">
        <Button type="link" size="small" className="mr-inline-link" onClick={() => navigate(`/data/${props.collection.id}/api`)}>
          <ArrowRightOutlined /> 查看此集合的 API
        </Button>
        <Button
          type="link"
          size="small"
          className="mr-inline-link"
          onClick={() => navigate(`/data/${props.collection.id}/access`)}
        >
          <ArrowRightOutlined /> 验证访问规则
        </Button>
      </div>

      <StatusTag tone="neutral">私人记录 · 受集合访问规则约束</StatusTag>
    </aside>
  )
}
