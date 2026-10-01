package requests

import (
	"context"
	"database/sql"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// Summary 是 RequestRecord 在一个时间窗口内的聚合事实，供总览使用。
// 它不返回任何请求内容、凭据或 Query 值。
//
// 缺省零值表示"窗口内没有记录"，而不是"读取失败"：调用方必须把错误与零值分开处理。
type Summary struct {
	// WindowCoveredFrom 是窗口内最早一条记录的时间。
	// 当请求日志留存窗口小于调用方请求的窗口时，它让界面可以如实说明实际覆盖范围。
	WindowCoveredFrom *time.Time `json:"windowCoveredFrom,omitempty"`
	RequestCount      int64      `json:"requestCount"`
	ClientErrorCount  int64      `json:"clientErrorCount"`
	ServerErrorCount  int64      `json:"serverErrorCount"`
	// P95DurationMS 只在窗口内存在记录时给出；没有记录时省略，不假装耗时为零。
	P95DurationMS *int64 `json:"p95DurationMs,omitempty"`
}

// Summary 聚合窗口内（occurredAt >= since）的请求事实。
// 计数与分位数都由 SQLite 直接计算，不物化记录行。
func (service *Service) Summary(ctx context.Context, since time.Time) (Summary, error) {
	if service == nil || service.store == nil {
		return Summary{}, ErrInvalidArgument
	}
	cutoff := since.UTC().UnixNano()
	var summary Summary
	var earliest sql.NullString
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		row := snapshot.QueryRowContext(ctx, `SELECT COUNT(*),
			COALESCE(SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END), 0),
			MIN(occurred_at)
			FROM modelry_request_records WHERE occurred_unix_nano >= ?`, cutoff)
		if err := row.Scan(&summary.RequestCount, &summary.ClientErrorCount, &summary.ServerErrorCount, &earliest); err != nil {
			return err
		}
		if summary.RequestCount == 0 {
			return nil
		}
		// 最近秩（nearest-rank）P95：1-based 序号为 ceil(0.95 × N)，换算成 0-based 偏移。
		offset := (95*summary.RequestCount + 99) / 100
		if offset > 0 {
			offset--
		}
		if offset > summary.RequestCount-1 {
			offset = summary.RequestCount - 1
		}
		var p95 int64
		if err := snapshot.QueryRowContext(ctx, `SELECT duration_ms FROM modelry_request_records
			WHERE occurred_unix_nano >= ? ORDER BY duration_ms LIMIT 1 OFFSET ?`, cutoff, offset).Scan(&p95); err != nil {
			return err
		}
		summary.P95DurationMS = &p95
		return nil
	})
	if err != nil {
		return Summary{}, err
	}
	if earliest.Valid {
		if parsed, parseErr := time.Parse(time.RFC3339Nano, earliest.String); parseErr == nil {
			summary.WindowCoveredFrom = &parsed
		}
	}
	return summary, nil
}
