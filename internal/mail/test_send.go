package mail

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// SendTest 同步发送一封测试邮件；结果作为一条耐久 test 投递记录保留。
func (service *Service) SendTest(ctx context.Context, recipient string) (Delivery, error) {
	config, err := service.GetConfig(ctx)
	if err != nil {
		return Delivery{}, err
	}
	if !config.Configured() {
		return Delivery{}, ErrNotConfigured
	}
	delivery, err := service.EnqueueStandalone(ctx, KindTest, recipient, "")
	if err != nil {
		return Delivery{}, err
	}
	claimed := delivery
	if err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, "UPDATE modelry_mail_deliveries SET status = ? WHERE id = ? AND status = ?", string(DeliveryRunning), delivery.ID, string(DeliveryPending))
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return fmt.Errorf("%w: the test delivery is no longer queued", ErrConflict)
		}
		return nil
	}); err != nil {
		return Delivery{}, err
	}
	claimed.Status = DeliveryRunning
	service.dispatch(context.WithoutCancel(ctx), claimed)
	return service.Delivery(ctx, delivery.ID)
}

// Delivery 读取单条投递。
func (service *Service) Delivery(ctx context.Context, deliveryID string) (Delivery, error) {
	var delivery Delivery
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		value, err := scanDelivery(tx.QueryRowContext(ctx, "SELECT id, kind, recipient, payload_ref, status, attempts, next_attempt_at, error_code, created_at, completed_at FROM modelry_mail_deliveries WHERE id = ?", deliveryID))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		delivery = value
		return nil
	})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Delivery{}, ErrNotFound
		}
		return Delivery{}, fmt.Errorf("%w: read Mail Delivery: %v", ErrUnavailable, err)
	}
	return delivery, nil
}
