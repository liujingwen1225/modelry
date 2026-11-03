import { useMemo } from 'react'
import { Button, CodeBlock, Mono, Notice, SectionHeading } from '@/ui'
import { CopyOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { Collection } from '@/api/collections'
import { runtimeOrigin } from '@/api/runtime'

/**
 * API 标签（Figma「数据 · notes API」）。
 *
 * 展示的是这条集合真实存在的应用 API：路径、方法与可直接运行的 curl。
 * 完整文档在「开发与连接」里，这里不重复一份会过期的副本。
 */
export function ApiTab(props: { collection: Collection }) {
  const navigate = useNavigate()
  const origin = runtimeOrigin()
  const name = props.collection.name

  const sample = useMemo(
    () =>
      [
        `curl ${origin}/api/v1/${name} \\`,
        `  -H "Authorization: Bearer $MODELRY_API_KEY" \\`,
        `  -H "Content-Type: application/json"`,
        '',
        `curl ${origin}/api/v1/${name} \\`,
        `  -H "Authorization: Bearer $MODELRY_API_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"${props.collection.fields.find((field) => !field.system)?.name ?? 'title'}": "第一条记录"}'`,
      ].join('\n'),
    [origin, name, props.collection.fields],
  )

  const endpoints = [
    { method: 'GET', path: `/api/v1/${name}`, purpose: '列出记录' },
    { method: 'POST', path: `/api/v1/${name}`, purpose: '创建记录' },
    { method: 'GET', path: `/api/v1/${name}/{recordId}`, purpose: '读取单条记录' },
    { method: 'PATCH', path: `/api/v1/${name}/{recordId}`, purpose: '更新记录' },
    { method: 'DELETE', path: `/api/v1/${name}/{recordId}`, purpose: '删除记录' },
    { method: 'GET', path: `/api/v1/${name}/events`, purpose: '订阅实时事件' },
  ]

  return (
    <div className="mr-api">
      <section className="mr-api__section">
        <SectionHeading title="调用地址" meta={<Mono>{origin}</Mono>} />
        <p className="mr-muted-note">应用 API 与管理面 API 分离：这里使用应用身份（API Key 或应用用户会话）。</p>
      </section>

      <CodeBlock code={sample} label="curl" maxHeight={260} />

      <section className="mr-api__section">
        <SectionHeading title="端点" />
        <ul className="mr-api__endpoints">
          {endpoints.map((endpoint) => (
            <li key={`${endpoint.method} ${endpoint.path}`}>
              <span className={`mr-api__method mr-api__method--${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
              <Mono>{endpoint.path}</Mono>
              <span className="mr-api__purpose">{endpoint.purpose}</span>
            </li>
          ))}
        </ul>
      </section>

      <Notice>
        还没有 API Key？在「开发与连接」创建服务账号和 API Key，然后回到这里复制请求。
        <Button type="link" size="small" className="mr-inline-link" onClick={() => navigate('/developer')}>
          打开开发与连接 →
        </Button>
      </Notice>

      <Notice tone="warning">
        访问规则决定这些端点返回什么：未登录的调用会按集合规则被拒绝，而不是返回空列表。
      </Notice>

      <Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard?.writeText(`${origin}/api/v1/${name}`)}>
        复制集合地址
      </Button>
    </div>
  )
}
