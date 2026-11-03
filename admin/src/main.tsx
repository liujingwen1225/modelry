import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import { App, ConfigProvider, antdTheme, zhCN } from '@/ui'
import { AppRoutes } from '@/routes/AppRoutes'
import '@/theme/tokens.css'

dayjs.locale('zh-cn')

/**
 * 查询层默认不重试：本地运行时要么立刻可用，要么需要用户先处理，
 * 静默重试会把「需要处理」拖成「一直转圈」。页面自行决定是否重试。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
    mutations: { retry: false },
  },
})

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root container is missing')
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={antdTheme} locale={zhCN} button={{ autoInsertSpace: false }}>
        <App>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </App>
      </ConfigProvider>
    </QueryClientProvider>
  </StrictMode>,
)
