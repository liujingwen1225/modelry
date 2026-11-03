import { Navigate } from 'react-router-dom'
import { Button, LoadingBlock, ErrorState, StateBlock } from '@/ui'
import { PlusOutlined, TableOutlined } from '@ant-design/icons'
import { useData } from './DataContext'

/**
 * /data 的入口：有集合时跳到第一个集合，没有集合时给出真实的空状态。
 * 空状态不是占位图，而是创建集合的真实入口。
 */
export function DataIndex() {
  const data = useData()

  if (data.loading) {
    return (
      <div className="mr-page">
        <LoadingBlock rows={4} label="正在读取集合…" />
      </div>
    )
  }

  if (data.error) {
    return (
      <div className="mr-page">
        <ErrorState error={data.error} title="集合列表读不到" onRetry={data.refresh} />
      </div>
    )
  }

  const first = data.collections[0]
  if (first) {
    return <Navigate to={`/data/${first.id}`} replace />
  }

  return (
    <div className="mr-page">
      <StateBlock
        eyebrow="空态"
        icon={<TableOutlined />}
        title="还没有集合"
        description="先定义一种数据，再添加第一条记录。系统会自动准备记录 ID、时间和 API。"
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={data.openCreate}>
            创建集合
          </Button>
        }
      />
    </div>
  )
}
