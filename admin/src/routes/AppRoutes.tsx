import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/app/AppShell'
import { BreadcrumbProvider } from '@/app/BreadcrumbContext'
import { ProjectProvider } from '@/app/ProjectProvider'
import { RequireAdmin } from '@/session/gate'
import { LoginPage } from '@/pages/login/LoginPage'
import { SetupPage } from '@/pages/setup/SetupPage'
import { OverviewPage } from '@/pages/overview/OverviewPage'
import { PendingModule } from '@/pages/pending/PendingModule'
import { DataLayout } from '@/pages/data/DataLayout'
import { DataIndex } from '@/pages/data/DataIndex'
import { CollectionPane } from '@/pages/data/CollectionPane'
import { AccessPage } from '@/pages/access/AccessPage'
import { Result } from '@/ui'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/overview" element={<Navigate to="/" replace />} />
      <Route
        element={
          <RequireAdmin>
            <ProjectProvider>
              <BreadcrumbProvider>
                <AppShell />
              </BreadcrumbProvider>
            </ProjectProvider>
          </RequireAdmin>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="data" element={<DataLayout />}>
          <Route index element={<DataIndex />} />
          <Route path=":collectionId" element={<CollectionPane />} />
          <Route path=":collectionId/:tab" element={<CollectionPane />} />
        </Route>
        <Route path="access" element={<AccessPage />} />
        <Route path="access/:tab" element={<AccessPage />} />
        <Route path="developer/*" element={<PendingModule />} />
        <Route path="logic/*" element={<PendingModule />} />
        <Route path="changes/*" element={<PendingModule />} />
        <Route path="ai/*" element={<PendingModule />} />
        <Route path="settings/*" element={<PendingModule />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

function NotFound() {
  return (
    <div className="mr-page">
      <Result status="404" title="页面不存在" subTitle="这个地址没有对应的页面。可以从概览重新开始。" />
    </div>
  )
}
