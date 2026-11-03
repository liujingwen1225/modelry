import { Navigate, useNavigate } from 'react-router-dom'
import { Button, Form, Input, Notice } from '@/ui'
import { errorMessage } from '@/api/client'
import { useAdminSession, useBootstrapStatus, useLogin } from '@/session/hooks'

type LoginValues = { email: string; password: string }

/** 管理面登录。Figma 没有该画板，但产品必须有安全入口；视觉沿用同一套设计变量。 */
export function LoginPage() {
  const navigate = useNavigate()
  const bootstrap = useBootstrapStatus()
  const session = useAdminSession()
  const login = useLogin()

  if (bootstrap.data?.state === 'required') {
    return <Navigate to="/setup" replace />
  }
  if (session.data) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="mr-auth">
      <div className="mr-auth__panel">
        <div className="mr-auth__brand">
          <span className="mr-nav__mark" aria-hidden>
            m
          </span>
          <span className="mr-nav__wordmark">Modelry</span>
        </div>
        <h1 className="mr-auth__title">登录本地管理面</h1>
        <p className="mr-auth__hint">这台设备上的 Modelry 实例。使用管理员账号继续。</p>
        <Form<LoginValues>
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            login.mutate(values, { onSuccess: () => navigate('/', { replace: true }) })
          }}
        >
          <Form.Item name="email" label="邮箱" rules={[{ required: true, message: '请输入邮箱' }]}>
            <Input type="email" autoComplete="username" placeholder="you@example.com" autoFocus />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete="current-password" placeholder="密码" />
          </Form.Item>
          {login.isError ? <Notice tone="danger">{errorMessage(login.error)}</Notice> : null}
          <Button type="primary" htmlType="submit" block loading={login.isPending} style={{ marginTop: 16 }}>
            登录
          </Button>
        </Form>
      </div>
    </div>
  )
}
