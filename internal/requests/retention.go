package requests

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// MaximumRequestRecordsPerPrune 是单次保留期清理删除上限，保证清理是有界操作。
const MaximumRequestRecordsPerPrune = 5000

// defaultRetentionPruneInterval 是清理 worker 的固定节拍。
const defaultRetentionPruneInterval = time.Minute

// PruneOlderThan 删除早于 cutoff 的 RequestRecord；它绝不触碰 AuditRecord。
func (service *Service) PruneOlderThan(ctx context.Context, cutoff time.Time, limit int) (int64, error) {
	if service == nil || service.store == nil {
		return 0, fmt.Errorf("%w: Request log service is not ready", ErrStorage)
	}
	if limit <= 0 || limit > MaximumRequestRecordsPerPrune {
		limit = MaximumRequestRecordsPerPrune
	}
	if cutoff.IsZero() {
		return 0, fmt.Errorf("%w: retention cutoff is required", ErrInvalidArgument)
	}
	var removed int64
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `DELETE FROM modelry_request_records WHERE request_id IN (
			SELECT request_id FROM modelry_request_records WHERE occurred_unix_nano < ? ORDER BY occurred_unix_nano ASC LIMIT ?)`,
			cutoff.UTC().UnixNano(), limit)
		if err != nil {
			return err
		}
		removed, err = result.RowsAffected()
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("%w: prune Request records: %v", ErrStorage, err)
	}
	return removed, nil
}

// RetentionSource 由 Runtime 注入：返回当前生效的保留天数。
type RetentionSource func(ctx context.Context) (int, error)

// StartRetention 启动 bounded、cancellable、restart-aware 的保留期清理 worker。
// 每次 tick 都重新读取配置，因此不需要重启即可生效；重复启动返回错误。
func (service *Service) StartRetention(parent context.Context, source RetentionSource) error {
	if service == nil {
		return fmt.Errorf("%w: Request log service is not ready", ErrStorage)
	}
	if source == nil {
		return fmt.Errorf("%w: retention source is required", ErrInvalidArgument)
	}
	service.retentionMu.Lock()
	if service.retentionStarted || service.retentionClosed {
		service.retentionMu.Unlock()
		return fmt.Errorf("%w: Request retention worker can only be started once", ErrInvalidArgument)
	}
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	service.retentionStarted = true
	service.retentionCancel = cancel
	service.retentionDone = make(chan struct{})
	done := service.retentionDone
	service.retentionMu.Unlock()

	go func() {
		defer close(done)
		ticker := time.NewTicker(service.retentionInterval())
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			days, err := source(ctx)
			if err != nil || days <= 0 {
				continue
			}
			cutoff := service.now().UTC().AddDate(0, 0, -days)
			for pass := 0; pass < 4; pass++ {
				removed, err := service.PruneOlderThan(ctx, cutoff, MaximumRequestRecordsPerPrune)
				if err != nil || removed < MaximumRequestRecordsPerPrune {
					break
				}
			}
		}
	}()
	return nil
}

// CloseRetention 取消进行中的清理并等待 worker 退出。
func (service *Service) CloseRetention(ctx context.Context) error {
	if service == nil {
		return nil
	}
	service.retentionMu.Lock()
	if service.retentionClosed {
		service.retentionMu.Unlock()
		return nil
	}
	service.retentionClosed = true
	cancel := service.retentionCancel
	done := service.retentionDone
	service.retentionMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (service *Service) retentionInterval() time.Duration {
	if service.interval > 0 {
		return service.interval
	}
	return defaultRetentionPruneInterval
}

var _ = errors.Is