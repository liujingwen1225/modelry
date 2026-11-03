import { useLocation } from 'react-router-dom'
import { StateBlock } from '@/ui'
import { sectionLabelOf } from '@/app/nav'

/**
 * 尚未交付的分区占位。
 *
 * 只说明当前状态与所属 Issue，不放置假按钮或示例数据；
 * 每个分区都会在对应 Issue 中被真实页面替换。
 */
export function PendingModule() {
  const location = useLocation()
  const label = sectionLabelOf(location.pathname)
  return (
    <div className="mr-page">
      <StateBlock
        eyebrow="按 Figma 设计交付中"
        title={`${label}还没有接入`}
        description="这一部分正在按 Figma 画板逐页实现，完成后会使用真实本地数据和可执行操作。"
      />
    </div>
  )
}
