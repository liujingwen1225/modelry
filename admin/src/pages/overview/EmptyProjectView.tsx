import { Button } from '@/ui'
import { CheckCircleFilled, PlusOutlined, TableOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { OverviewSnapshot } from '@/api/overview'
import { useProject } from '@/app/ProjectProvider'
import { useBreadcrumbTail } from '@/app/BreadcrumbContext'
import { dataDirectoryLabel } from '@/api/runtime'
import { attachName, formatCount } from '@/lib/format'
import './overview.css'

/**
 * 首次进入 · 空项目（Figma #20:15968）。
 *
 * 与「概览 · 继续工作」是同一路由的两种状态：项目里没有任何集合时进入这里。
 * 引导步骤、手动入口和 AI 入口都指向真实可执行的下一步。
 */
export function EmptyProjectView(props: { snapshot: OverviewSnapshot }) {
  useBreadcrumbTail([])
  const navigate = useNavigate()
  const project = useProject()
  const dataRoot = dataDirectoryLabel(project.dataRoot)

  return (
    <div className="mr-page mr-page--wide">
      <header className="mr-empty__heading">
        <h1 className="mr-overview__title">从第一份数据开始</h1>
        <p className="mr-overview__lede">{attachName(project.name, '已在本地准备就绪。先定义数据，再把它接到你的应用。')}</p>
      </header>

      <div className="mr-empty__status">
        <CheckCircleFilled className="mr-empty__status-icon" />
        <span>
          本地实例可用 · localhost:{project.port} · SQLite · 数据保存在你的设备上
        </span>
      </div>

      <section className="mr-steps" aria-label="首次使用步骤">
        <Step index={1} title="建集合" description="定义一种应用数据，例如笔记、书单。" state="当前步骤" active />
        <Step index={2} title="加数据" description="手动录入第一条记录，检查字段。" state="创建集合后继续" />
        <Step index={3} title="接前端" description="复制本地 API，带上登录身份调用。" state="有数据后继续" />
      </section>

      <div className="mr-divider-line" />

      <section className="mr-empty__entries">
        <div className="mr-empty__entry">
          <TableOutlined className="mr-empty__entry-icon" />
          <h2 className="mr-empty__entry-title">先建一个集合</h2>
          <p className="mr-empty__entry-text">
            从名称和字段开始，不需要写代码。系统会自动准备记录 ID、时间和 API。
          </p>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/data')}>
            创建集合
          </Button>
          <span className="mr-empty__entry-hint">你随时可以手动编辑结构与访问规则。</span>
        </div>

        <div className="mr-empty__entry mr-empty__entry--ai">
          <ThunderboltOutlined className="mr-empty__entry-icon" />
          <h2 className="mr-empty__entry-title">也可以和 AI 一起梳理</h2>
          <p className="mr-empty__entry-text">
            描述你想保存什么，AI 帮你准备一个可审阅的结构方案。确认前不会修改项目。
          </p>
          <Button onClick={() => navigate('/ai')}>让 AI 帮我设计</Button>
          <span className="mr-empty__entry-hint">可选辅助，不需要从聊天开始。</span>
        </div>
      </section>

      <div className="mr-divider-line" />

      <section className="mr-project-facts">
        <h2 className="mr-project-facts__title">当前项目</h2>
        <p className="mr-project-facts__text">{attachName('一个本地实例，只服务于', project.name)}。</p>
        <div className="mr-project-facts__row">
          <span>{formatCount(props.snapshot.collections?.count ?? 0)} 个集合</span>
          <span>{formatCount(props.snapshot.collections?.recordCount ?? 0)} 条记录</span>
          <span>尚未创建应用用户</span>
          <span className="mr-mono">{dataRoot}</span>
        </div>
      </section>
    </div>
  )
}

function Step(props: { index: number; title: string; description: string; state: string; active?: boolean }) {
  return (
    <div className="mr-step">
      <span className={`mr-step__index${props.active ? ' mr-step__index--active' : ''}`}>{props.index}</span>
      <h3 className="mr-step__title">{props.title}</h3>
      <p className="mr-step__description">{props.description}</p>
      <span className={`mr-step__state${props.active ? ' mr-step__state--active' : ''}`}>{props.state}</span>
    </div>
  )
}
