import { Navigate, useNavigate } from 'react-router-dom'
import { Button, Form, Input, Notice } from '@/ui'
import { errorMessage } from '@/api/client'
import { useBootstrapStatus, useCreateOwner } from '@/session/hooks'

type SetupValues = { email: string; password: string; confirm: string }

/**
 * 首次设置：创建本实例唯一的 Owner。
 *
 * Figma 没有该画板，但缺少这一步无法安全进入管理面，因此保留最小必要页面。
 */
export function SetupPage() {
  const navigate = useNavigate()
  const bootstrap = useBootstrapStatus()
  const createOwner = useCreateOwner()

  if (bootstrap.data?.state === 'closed') {
    return <Navigate to="/login" replace />
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
        <h1 className="mr-auth__title">创建管理员账号</h1>
        <p className="mr-auth__hint">这是这台设备上的第一个账号，拥有完整管理权限。凭据只保存在本地。</p>
        <Form<SetupValues>
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            createOwner.mutate(
              { email: values.email, password: values.password },
              { onSuccess: () => navigate('/', { replace: true }) },
            )
          }}
        >
          <Form.Item name="email" label="邮箱" rules={[{ required: true, message: '请输入邮箱' }]}>
            <Input type="email" autoComplete="username" placeholder="you@example.com" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 8, message: '至少 8 个字符' },
            ]}
          >
            <Input.Password autoComplete="new-password" placeholder="至少 8 个字符" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认密码"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator: (_rule, value: string) =>
                  !value || getFieldValue('password') === value
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入的密码不一致')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" placeholder="再次输入密码" />
          </Form.Item>
          {createOwner.isError ? <Notice tone="danger">{errorMessage(createOwner.error)}</Notice> : null}
          <Button type="primary" htmlType="submit" block loading={createOwner.isPending} style={{ marginTop: 16 }}>
            创建并进入
          </Button>
        </Form>
      </div>
    </div>
  )
}
