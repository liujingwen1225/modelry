import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Field, Input, LoadingBlock, ErrorState, Notice, Select, Switch } from '@/ui'
import { errorMessage } from '@/api/client'
import {
  projectPreferencesApi,
  settingsKeys,
  type ProjectPreferences,
  type ProjectPreferencesUpdate,
} from '@/api/settings'

/**
 * Figma 画板 22「基本设置」标签。
 *
 * 项目名称、说明、工作台语言、外观与保存反馈开关都持久化到
 * GET/PUT /admin/api/v1/project-preferences，刷新与重启后仍可读取。
 * 没有硬编码的示例项目名；默认值来自后端真实返回。
 */
export function BasicSettingsPanel() {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const query = useQuery({ queryKey: settingsKeys.preferences, queryFn: projectPreferencesApi.get })
  const [draft, setDraft] = useState<Omit<ProjectPreferencesUpdate, 'expectedRevision'> | null>(null)
  const [baseRevision, setBaseRevision] = useState<number | null>(null)

  useEffect(() => {
    if (!query.data) return
    if (baseRevision === query.data.revision) return
    setDraft({
      projectName: query.data.projectName,
      projectDescription: query.data.projectDescription,
      locale: query.data.locale,
      appearance: query.data.appearance,
      saveFeedback: query.data.saveFeedback,
    })
    setBaseRevision(query.data.revision)
  }, [query.data, baseRevision])

  const save = useMutation({
    mutationFn: (body: ProjectPreferencesUpdate) => projectPreferencesApi.update(body),
    onSuccess: async (result) => {
      setBaseRevision(result.revision)
      await queryClient.invalidateQueries({ queryKey: settingsKeys.preferences })
      message.success(`基本设置已保存 · 修订 ${result.revision}`)
    },
    onError: (error: unknown) => message.error(`保存失败：${errorMessage(error)}`),
  })

  if (query.isPending) return <LoadingBlock rows={5} label="正在读取基本设置…" />
  if (query.isError) {
    return <ErrorState error={query.error} title="基本设置读不到" onRetry={() => void query.refetch()} />
  }
  if (!draft || !query.data) return <Notice>服务端没有返回基本设置内容。</Notice>

  const revision = query.data.revision
  const dirty =
    draft.projectName !== query.data.projectName ||
    draft.projectDescription !== query.data.projectDescription ||
    draft.locale !== query.data.locale ||
    draft.appearance !== query.data.appearance ||
    draft.saveFeedback !== query.data.saveFeedback

  const patch = (next: Partial<typeof draft>) => setDraft((current) => (current ? { ...current, ...next } : current))

  return (
    <div className="mr-settings__basic">
      <Notice>这些是项目级展示偏好，不会改变监听地址、请求保留天数等运行时行为；刷新后仍从本地实例读取。</Notice>

      <Field label="项目名称" hint="留空表示尚未命名；最多 64 个字符。">
        <Input
          aria-label="项目名称"
          value={draft.projectName}
          maxLength={64}
          placeholder="未命名项目"
          onChange={(event) => patch({ projectName: event.target.value })}
        />
      </Field>

      <Field label="项目说明" hint="最多 256 个字符，只用于工作台展示。">
        <Input.TextArea
          aria-label="项目说明"
          value={draft.projectDescription}
          maxLength={256}
          rows={3}
          placeholder="这个项目用来做什么"
          onChange={(event) => patch({ projectDescription: event.target.value })}
        />
      </Field>

      <Field label="工作台语言" hint="当前前端按 Figma 使用简体中文；切换语言只保存偏好，不伪造翻译结果。">
        <Select
          aria-label="工作台语言"
          value={draft.locale}
          options={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en-US', label: 'English' },
          ]}
          onChange={(value: ProjectPreferences['locale']) => patch({ locale: value })}
        />
      </Field>

      <Field label="外观" hint="Figma 只设计了桌面端浅色；其余选项会作为偏好保存，但不改变当前视觉基线。">
        <Select
          aria-label="外观"
          value={draft.appearance}
          options={[
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
            { value: 'system', label: '跟随系统' },
          ]}
          onChange={(value: ProjectPreferences['appearance']) => patch({ appearance: value })}
        />
      </Field>

      <div className="mr-settings__switch-row">
        <div>
          <strong>显示操作后的保存反馈</strong>
          <p className="mr-meta">保存、应用等操作完成后显示成功或失败提示。</p>
        </div>
        <Switch
          aria-label="显示操作后的保存反馈"
          checked={draft.saveFeedback}
          onChange={(checked) => patch({ saveFeedback: checked })}
        />
      </div>

      {save.isError ? <Notice tone="danger">保存失败：{errorMessage(save.error)}</Notice> : null}

      <div className="mr-settings__basic-actions">
        <span className="mr-meta">修订 {revision}</span>
        <div>
          <Button
            disabled={!dirty || save.isPending}
            onClick={() =>
              setDraft({
                projectName: query.data!.projectName,
                projectDescription: query.data!.projectDescription,
                locale: query.data!.locale,
                appearance: query.data!.appearance,
                saveFeedback: query.data!.saveFeedback,
              })
            }
          >
            放弃修改
          </Button>
          <Button
            type="primary"
            loading={save.isPending}
            disabled={!dirty}
            onClick={() => save.mutate({ expectedRevision: revision, ...draft })}
          >
            保存设置
          </Button>
        </div>
      </div>
    </div>
  )
}
