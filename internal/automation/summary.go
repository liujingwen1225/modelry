package automation

import (
	"context"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// Summary 是 Hooks & Events / 定时任务在一个时间窗口内的聚合事实。
// 它只返回计数与启用状态，不返回目标 URL、Secret、payload 或响应内容。
type Summary struct {
	EnabledWebhooks      int   `json:"enabledWebhooks"`
	EnabledEventHooks    int   `json:"enabledEventHooks"`
	EnabledJobs          int   `json:"enabledJobs"`
	DeliveryCount        int64 `json:"deliveryCount"`
	FailedDeliveryCount  int64 `json:"failedDeliveryCount"`
	PendingDeliveryCount int64 `json:"pendingDeliveryCount"`
}

// Summary 统计窗口内（createdAt >= since）的投递事实与当前启用数量。
// created_at 由 Runtime 以 RFC3339Nano UTC 写入，因此这里比较固定长度的时间前缀
// （精确到秒），既不依赖 SQLite 的日期解析，也不受小数位差异影响。
func (service *Service) Summary(ctx context.Context, since time.Time) (Summary, error) {
	if service == nil || service.store == nil {
		return Summary{}, ErrInvalidArgument
	}
	cutoff := since.UTC().Format("2006-01-02T15:04:05")
	var summary Summary
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		for _, query := range []struct {
			statement string
			target    *int
		}{
			{`SELECT COUNT(*) FROM modelry_automation_webhooks WHERE enabled = 1`, &summary.EnabledWebhooks},
			{`SELECT COUNT(*) FROM modelry_automation_event_hooks WHERE enabled = 1`, &summary.EnabledEventHooks},
			{`SELECT COUNT(*) FROM modelry_automation_jobs WHERE enabled = 1`, &summary.EnabledJobs},
		} {
			var count int
			if err := snapshot.QueryRowContext(ctx, query.statement).Scan(&count); err != nil {
				return err
			}
			*query.target = count
		}
		return snapshot.QueryRowContext(ctx, `SELECT
			COALESCE(SUM(CASE WHEN substr(created_at, 1, 19) >= ? THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN substr(created_at, 1, 19) >= ? AND status = 'failed' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END), 0)
			FROM modelry_automation_deliveries`, cutoff, cutoff).
			Scan(&summary.DeliveryCount, &summary.FailedDeliveryCount, &summary.PendingDeliveryCount)
	})
	if err != nil {
		return Summary{}, err
	}
	return summary, nil
}
