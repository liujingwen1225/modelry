/**
 * 时间与数字的展示格式。全部按中文本地习惯，不使用服务端原始时间字符串。
 */

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

export function parseTime(value?: string | null): Date | undefined {
  if (!value) {
    return undefined
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** 「2026 年 11 月 3 日，星期二」 */
export function formatLongDate(value: Date = new Date()): string {
  return `${value.getFullYear()} 年 ${value.getMonth() + 1} 月 ${value.getDate()} 日，星期${WEEKDAYS[value.getDay()]}`
}

/** 同一天用「今天 / 昨天 HH:mm」，今年用「MM-DD HH:mm」，更早带年份。 */
export function formatMoment(value?: string | null): string {
  const date = parseTime(value)
  if (!date) {
    return '—'
  }
  const now = new Date()
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayDiff = Math.floor((startOfToday - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000)

  if (dayDiff === 0) {
    return `今天 ${time}`
  }
  if (dayDiff === 1) {
    return `昨天 ${time}`
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 只显示时间部分，用于同一天内的紧凑列表。 */
export function formatClock(value?: string | null): string {
  const date = parseTime(value)
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '—'
}

/** 页面顶部的完整日期时间，用于技术详情。 */
export function formatDateTime(value?: string | null): string {
  const date = parseTime(value)
  if (!date) {
    return '—'
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatCount(value?: number | null): string {
  if (value === undefined || value === null) {
    return '—'
  }
  return value.toLocaleString('zh-CN')
}

/** 字节数：本地文件大小与技术详情共用。 */
export function formatBytes(value?: number | null): string {
  if (value === undefined || value === null) {
    return '—'
  }
  if (value < 1024) {
    return `${value} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`
}

/**
 * 项目名后接中文句子时的连接。
 *
 * 项目名来自目录名，可能是英文或中文；英文名与中文之间补一个空格，
 * 避免出现「empty-proj已…」这种粘连。
 */
export function attachName(name: string, rest: string): string {
  return /[A-Za-z0-9]$/.test(name) ? `${name} ${rest}` : `${name}${rest}`
}
