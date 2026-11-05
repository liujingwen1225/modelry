/**
 * AI 变更审阅 · 公开分享（Figma 画板 24）。
 *
 * 未登录可访问的公开只读页：不依赖 RequireAdmin / ProjectProvider / AppShell，
 * 也不渲染任何管理面导航。只读端点返回的是裸对象（不是 { data }）。
 *
 * 安全要求：token 无效 / 过期 / 已撤销一律 404 SHARE_NOT_FOUND，前端对任何错误
 * 都展示同一个「链接不可用或已失效」空状态，不区分原因、不显示 errorMessage /
 * requestId / 状态码；页面不展示 Secret、凭据、记录内容或服务器绝对路径。
 */
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileProtectOutlined,
  InfoCircleOutlined,
  LinkOutlined,
} from '@ant-design/icons'
import {
  Button,
  DetailList,
  LoadingBlock,
  Notice,
  StateBlock,
  StatusTag,
  Typography,
} from '@/ui'
import {
  AI_RISK_LABEL,
  AI_RISK_TONE,
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_TONE,
  aiKeys,
  aicollabApi,
} from '@/api/aicollab'
import { formatDateTime } from '@/lib/format'
import './ai.css'

type Tone = 'neutral' | 'success' | 'warning' | 'danger'

function statusLabel(status: string): string {
  return PROPOSAL_STATUS_LABEL[status] ?? status
}

function statusTone(status: string): Tone {
  return PROPOSAL_STATUS_TONE[status] ?? 'neutral'
}

function riskLabel(risk: string): string {
  return AI_RISK_LABEL[risk] ?? risk
}

function riskTone(risk: string): Tone {
  return AI_RISK_TONE[risk] ?? 'neutral'
}

export function AISharePage() {
  const { token } = useParams<{ token: string }>()

  // 公开只读端点是裸对象；任何失败都不重试、不读取错误细节。
  const query = useQuery({
    queryKey: aiKeys.publicShare(token ?? ''),
    queryFn: () => aicollabApi.publicShare(token!),
    enabled: Boolean(token),
    retry: false,
  })

  // 统一失效态：无效 / 过期 / 撤销 / 网络错误一律相同文案，不泄漏原因差异。
  const invalid = !token || query.isError
  const loading = Boolean(token) && query.isPending
  const share = query.data
  // 真实后端 plan 总是对象，尚无方案时 risk 为空字符串。
  const hasPlan = Boolean(share?.plan?.risk)
  const planRisk = share?.plan?.risk ?? ''

  return (
    <div className="mr-ai-share">
      <div className="mr-ai-share__inner">
        <div className="mr-ai-share__head">
          <span className="mr-ai-share__brand"><FileProtectOutlined /> 变更审阅 · 公开分享</span>
          <StatusTag tone="neutral">只读</StatusTag>
        </div>

        {invalid ? (
          <div className="mr-ai-share__card">
            <StateBlock
              eyebrow="公开分享"
              icon={<LinkOutlined />}
              title="链接不可用或已失效"
              description="这条分享链接可能无效、已过期或已被撤销。如需查看，请向链接提供者索取新的只读链接。"
              actions={token ? <Button onClick={() => void query.refetch()}>重新加载</Button> : undefined}
            />
          </div>
        ) : loading ? (
          <div className="mr-ai-share__card">
            <LoadingBlock rows={5} label="正在读取公开提案摘要…" />
          </div>
        ) : share ? (
          <>
            <div className="mr-ai-share__card">
              <div className="mr-ai-share__status">
                <StatusTag tone={statusTone(share.status)}>{statusLabel(share.status)}</StatusTag>
                <span className="mr-meta">提案摘要 · 只读</span>
              </div>
              <Typography.Title level={2} className="mr-ai-share__title">{share.title}</Typography.Title>
              <p className="mr-ai-share__lede">这是提案的只读摘要，不包含记录内容、Secret、凭据或服务器路径。</p>

              <div className="mr-ai-share__req">
                <span className="mr-ai-share__req-label">需求</span>
                <p className="mr-ai-share__req-text">{share.requirement}</p>
              </div>

              <DetailList
                items={[
                  { label: '目标集合', value: share.collectionName || '—' },
                  { label: '目标字段', value: share.fieldName || '—' },
                  { label: '提案状态', value: statusLabel(share.status), mono: false },
                  { label: '风险', value: hasPlan ? riskLabel(planRisk) : '尚未生成方案', mono: false },
                  { label: '影响摘要', value: share.plan?.impactSummary || '—', mono: false },
                  { label: '差异条目', value: hasPlan ? String(share.plan?.diffCount ?? 0) : '—', mono: false },
                  { label: '链接过期时间', value: formatDateTime(share.expiresAt), mono: false },
                ]}
              />
              {hasPlan ? (
                <div className="mr-ai-share__risk">
                  <StatusTag tone={riskTone(planRisk)}>风险 · {riskLabel(planRisk)}</StatusTag>
                </div>
              ) : null}
            </div>

            <div className="mr-ai-share__card">
              <div className="mr-ai-share__section-head">
                <span className="mr-ai-share__section-title">验证结论</span>
                {share.verification ? (
                  <StatusTag tone={share.verification.passed ? 'success' : 'danger'}>
                    {share.verification.passed ? '已通过' : '未通过'}
                  </StatusTag>
                ) : (
                  <StatusTag tone="neutral">尚未验证</StatusTag>
                )}
              </div>
              {!share.verification ? (
                <p className="mr-ai-share__hint">这条提案还没有验证结论。</p>
              ) : (
                <>
                  <ul className="mr-ai-share__checks">
                    {share.verification.checks.map((check, index) => (
                      <li className="mr-ai-share__check" key={`${check.label}-${index}`}>
                        <span className={`mr-ai-share__check-icon${check.passed ? ' mr-ai-share__check-icon--pass' : ' mr-ai-share__check-icon--fail'}`}>
                          {check.passed ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                        </span>
                        <span className="mr-ai-share__check-body">
                          <strong>{check.label}</strong>
                          <span className="mr-ai-share__check-detail">{check.detail || '（无更多说明）'}</span>
                        </span>
                        <StatusTag tone={check.passed ? 'success' : 'danger'}>{check.passed ? '通过' : '未通过'}</StatusTag>
                      </li>
                    ))}
                  </ul>
                  <Notice tone={share.verification.passed ? 'success' : 'danger'}>
                    共 {share.verification.checks.length} 项真实检查，{share.verification.passed ? '全部通过' : '存在未通过项'}。
                  </Notice>
                </>
              )}
            </div>

            <div className="mr-ai-share__foot">
              <Notice tone="neutral" icon={<InfoCircleOutlined />}>
                这是公开只读页面：链接到时自动失效，只暴露提案摘要；不含管理面导航、记录内容、Secret、凭据或绝对路径。
              </Notice>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
