import { useMemo } from 'react'
import { Avatar, Button, Dropdown, Menu } from '@/ui'
import type { MenuProps } from '@/ui'
import { LogoutOutlined, SettingOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { PRIMARY_NAV, REVIEW_NAV, sectionLabelOf, sectionOfPath } from './nav'
import { useBreadcrumbTailValue } from './BreadcrumbContext'
import { useProject } from './ProjectProvider'
import { useAdminSession, useLogout } from '@/session/hooks'
import './app.css'

/**
 * 全局工作区外壳，严格对应 Figma「主导航」与「全局页眉」。
 *
 * 左侧固定 216px 导航；右侧 64px 页眉 + 页面工作面。
 * 导航项、分组、底部本地信息都只来自 Figma，不按后端能力扩展。
 */
export function AppShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const project = useProject()
  const session = useAdminSession()
  const logout = useLogout()
  const breadcrumbTail = useBreadcrumbTailValue()

  const section = sectionOfPath(location.pathname)
  const sectionLabel = sectionLabelOf(location.pathname)
  const email = session.data?.owner.email ?? ''
  const avatarChar = (email.trim()[0] ?? '本').toUpperCase()

  const primaryItems = useMemo<MenuProps['items']>(
    () =>
      PRIMARY_NAV.map((entry) => ({
        key: entry.path,
        icon: entry.icon,
        label: entry.label,
      })),
    [],
  )

  const selectedKeys = [section === 'changes' ? REVIEW_NAV.path : (PRIMARY_NAV.find((entry) => entry.id === section)?.path ?? '/')]

  const statusText = project.healthy ? '本地实例 · 运行中' : '本地实例 · 需要处理'

  return (
    <div className="mr-app">
      <nav className="mr-nav" aria-label="主导航">
        <div className="mr-nav__brand">
          <span className="mr-nav__mark" aria-hidden>
            m
          </span>
          <span className="mr-nav__wordmark">Modelry</span>
        </div>

        <div className="mr-nav__project">
          <span className="mr-nav__project-name" title={project.dataRoot}>
            {project.name}
          </span>
          <span className="mr-nav__status">
            <span className={`mr-nav__dot${project.healthy ? '' : ' mr-nav__dot--warn'}`} aria-hidden />
            {statusText}
          </span>
        </div>

        <Menu
          mode="inline"
          inlineIndent={0}
          className="mr-nav__menu"
          selectedKeys={selectedKeys}
          items={primaryItems}
          onClick={({ key }) => navigate(key)}
        />

        <p className="mr-nav__hint">API · 请求日志 · Secrets</p>

        <div className="mr-nav__review">
          <div className="mr-nav__divider" />
          <Menu
            mode="inline"
            inlineIndent={0}
            className="mr-nav__menu mr-nav__menu--review"
            selectedKeys={selectedKeys}
            items={[
              {
                key: REVIEW_NAV.path,
                icon: REVIEW_NAV.icon,
                label: (
                  <span className="mr-nav__review-label">
                    待审阅变更
                    <span className="mr-nav__count" aria-label={`${project.needsReview} 项待审阅`}>
                      {project.needsReview}
                    </span>
                  </span>
                ),
              },
            ]}
            onClick={({ key }) => navigate(key)}
          />
        </div>

        <div className="mr-nav__spacer" />

        <div className="mr-nav__footer">
          <Button
            type="text"
            className="mr-nav__settings"
            icon={<SettingOutlined />}
            onClick={() => navigate('/settings')}
          >
            设置
          </Button>
          <div className="mr-nav__divider" />
          <span className="mr-nav__origin">localhost:{project.port}</span>
          <span className="mr-nav__footnote">SQLite · 单实例 / 单项目</span>
        </div>
      </nav>

      <div className="mr-workspace">
        <header className="mr-topbar">
          <nav className="mr-topbar__crumbs" aria-label="当前位置">
            <span className="mr-topbar__project">{project.name}</span>
            <span className="mr-topbar__separator">/</span>
            <span className="mr-topbar__current">{sectionLabel}</span>
            {breadcrumbTail.map((segment) => (
              <span key={segment} className="mr-topbar__segment">
                <span className="mr-topbar__separator">/</span>
                <span className="mr-topbar__current">{segment}</span>
              </span>
            ))}
          </nav>
          <div className="mr-topbar__tools">
            <span className="mr-topbar__context">本地工作台</span>
            <Button type="text" className="mr-topbar__ai" icon={<ThunderboltOutlined />} onClick={() => navigate('/ai')}>
              AI 助手
            </Button>
            <Dropdown
              trigger={['click']}
              placement="bottomRight"
              menu={{
                items: [
                  { key: 'identity', label: email || '本地管理员', disabled: true },
                  { type: 'divider' },
                  { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: () => logout.mutate() },
                ],
              }}
            >
              <Button type="text" className="mr-topbar__avatar-button" aria-label="管理员账号">
                <Avatar size={27} className="mr-topbar__avatar">
                  {avatarChar}
                </Avatar>
              </Button>
            </Dropdown>
          </div>
        </header>

        <main className="mr-canvas">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
