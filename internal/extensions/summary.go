package extensions

import (
	"context"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// HookSummary 是生命周期 Hook（Extension）在一个时间窗口内的聚合事实。
// 它只返回计数，不返回源码、绑定、Secret 或运行错误内容。
// 名称与 types.go 中单个 Extension 的 Summary 区分开。
type HookSummary struct {
	Enabled  int   `json:"enabled"`
	RunCount int64 `json:"runCount"`
	// FailedRunCount 只统计窗口内以 failed / interrupted 结束的运行。
	FailedRunCount int64 `json:"failedRunCount"`
}

// Summary 统计当前启用数量与窗口内（startedAt >= since）的运行事实。
// started_at 由 Runtime 以 RFC3339Nano UTC 写入，因此比较固定长度的时间前缀（精确到秒）。
func (service *Service) Summary(ctx context.Context, since time.Time) (HookSummary, error) {
	if service == nil || service.store == nil {
		return HookSummary{}, ErrInvalidArgument
	}
	cutoff := since.UTC().Format("2006-01-02T15:04:05")
	var summary HookSummary
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var enabled int
		if err := snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_extensions WHERE enabled = 1`).Scan(&enabled); err != nil {
			return err
		}
		summary.Enabled = enabled
		return snapshot.QueryRowContext(ctx, `SELECT
			COALESCE(SUM(CASE WHEN substr(started_at, 1, 19) >= ? THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN substr(started_at, 1, 19) >= ? AND status IN ('failed', 'interrupted') THEN 1 ELSE 0 END), 0)
			FROM modelry_extension_runs`, cutoff, cutoff).Scan(&summary.RunCount, &summary.FailedRunCount)
	})
	if err != nil {
		return HookSummary{}, err
	}
	return summary, nil
}
