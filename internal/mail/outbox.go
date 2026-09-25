package mail

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// Status 是 Mail Provider 与 outbox 的安全投影。
type Status struct {
	Config           Config
	Pending          int
	Failed           int
	Succeeded        int
	UsernameConfigured bool
	PasswordConfigured bool
}

func normalizeRecipient(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	address, err := mail.ParseAddress(trimmed)
	if err != nil || address.Address != trimmed {
		return "", fmt.Errorf("%w: a single valid recipient address is required", ErrInvalidArgument)
	}
	return address.Address, nil
}

func newDeliveryID() (string, error) {
	value := make([]byte, 16)
	if _, err := randRead(value); err != nil {
		return "", fmt.Errorf("generate Mail Delivery identifier: %w", err)
	}
	return "mail_" + hexEncode(value), nil
}

// Enqueue 在调用方事务内写入一个 durable 投递意图；容量上限 fail closed。
func (service *Service) Enqueue(ctx context.Context, tx storage.Executor, kind DeliveryKind, recipient, payloadRef string) (Delivery, error) {
	if tx == nil {
		return Delivery{}, fmt.Errorf("%w: a caller transaction is required", ErrInvalidArgument)
	}
	normalizedRecipient, err := normalizeRecipient(recipient)
	if err != nil {
		return Delivery{}, err
	}
	switch kind {
	case KindTest, KindVerification, KindPasswordReset:
	default:
		return Delivery{}, fmt.Errorf("%w: unsupported delivery kind", ErrInvalidArgument)
	}
	var pending int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM modelry_mail_deliveries WHERE status IN (?, ?)", string(DeliveryPending), string(DeliveryRunning)).Scan(&pending); err != nil {
		return Delivery{}, err
	}
	if pending >= MaximumPendingDeliveries {
		return Delivery{}, fmt.Errorf("%w: the Mail queue is full; wait for pending deliveries to finish", ErrCapacity)
	}
	id, err := newDeliveryID()
	if err != nil {
		return Delivery{}, err
	}
	now := service.timestamp()
	if _, err := tx.ExecContext(ctx, "INSERT INTO modelry_mail_deliveries (id, kind, recipient, payload_ref, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
		id, string(kind), normalizedRecipient, payloadRef, string(DeliveryPending), now, now); err != nil {
		return Delivery{}, err
	}
	if err := service.pruneDeliveries(ctx, tx); err != nil {
		return Delivery{}, err
	}
	return Delivery{ID: id, Kind: kind, Recipient: normalizedRecipient, PayloadRef: payloadRef, Status: DeliveryPending, CreatedAt: time.Unix(now, 0).UTC()}, nil
}

func (service *Service) pruneDeliveries(ctx context.Context, tx storage.Executor) error {
	_, err := tx.ExecContext(ctx, "DELETE FROM modelry_mail_deliveries WHERE id IN (SELECT id FROM modelry_mail_deliveries WHERE status IN (?, ?, ?, ?) ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)",
		string(DeliverySucceeded), string(DeliveryFailed), string(DeliveryCancelled), string(DeliveryInterrupted), MaximumRetainedDeliveries)
	return err
}

// EnqueueStandalone 在独立事务内写入投递意图，供测试邮件等独立动作使用。
func (service *Service) EnqueueStandalone(ctx context.Context, kind DeliveryKind, recipient, payloadRef string) (Delivery, error) {
	var delivery Delivery
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		value, err := service.Enqueue(ctx, tx, kind, recipient, payloadRef)
		if err != nil {
			return err
		}
		delivery = value
		return nil
	})
	if err != nil {
		return Delivery{}, err
	}
	service.wakeWorker()
	return delivery, nil
}

// ListDeliveries 返回最近的投递历史。
func (service *Service) ListDeliveries(ctx context.Context, limit int) ([]Delivery, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	result := make([]Delivery, 0, limit)
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		rows, err := tx.QueryContext(ctx, "SELECT id, kind, recipient, payload_ref, status, attempts, next_attempt_at, error_code, created_at, completed_at FROM modelry_mail_deliveries ORDER BY created_at DESC, id DESC LIMIT ?", limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			delivery, err := scanDelivery(rows)
			if err != nil {
				return err
			}
			result = append(result, delivery)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("%w: list Mail Deliveries: %v", ErrUnavailable, err)
	}
	return result, nil
}

func scanDelivery(row interface{ Scan(...any) error }) (Delivery, error) {
	var delivery Delivery
	var kind, status string
	var nextAttempt, completed sql.NullInt64
	var created int64
	if err := row.Scan(&delivery.ID, &kind, &delivery.Recipient, &delivery.PayloadRef, &status, &delivery.Attempts, &nextAttempt, &delivery.ErrorCode, &created, &completed); err != nil {
		return Delivery{}, err
	}
	delivery.Kind = DeliveryKind(kind)
	delivery.Status = DeliveryStatus(status)
	delivery.CreatedAt = time.Unix(created, 0).UTC()
	if nextAttempt.Valid {
		value := time.Unix(nextAttempt.Int64, 0).UTC()
		delivery.NextAttemptAt = &value
	}
	if completed.Valid {
		value := time.Unix(completed.Int64, 0).UTC()
		delivery.CompletedAt = &value
	}
	return delivery, nil
}

// RetryDelivery 把一个失败或中断的投递重新放回队列。
func (service *Service) RetryDelivery(ctx context.Context, deliveryID string) (Delivery, error) {
	now := service.timestamp()
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, "UPDATE modelry_mail_deliveries SET status = ?, attempts = 0, next_attempt_at = ?, error_code = '' WHERE id = ? AND status IN (?, ?)",
			string(DeliveryPending), now, deliveryID, string(DeliveryFailed), string(DeliveryInterrupted))
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			var exists int
			if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM modelry_mail_deliveries WHERE id = ?", deliveryID).Scan(&exists); err != nil {
				return err
			}
			if exists == 0 {
				return ErrNotFound
			}
			return fmt.Errorf("%w: only failed or interrupted deliveries can be retried", ErrConflict)
		}
		return service.appendAudit(ctx, tx, "mail.deliveryRetried", deliveryID)
	})
	if err != nil {
		return Delivery{}, err
	}
	service.wakeWorker()
	var delivery Delivery
	err = service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		value, err := scanDelivery(tx.QueryRowContext(ctx, "SELECT id, kind, recipient, payload_ref, status, attempts, next_attempt_at, error_code, created_at, completed_at FROM modelry_mail_deliveries WHERE id = ?", deliveryID))
		if err != nil {
			return err
		}
		delivery = value
		return nil
	})
	if err != nil {
		return Delivery{}, err
	}
	return delivery, nil
}

// Status 汇总配置与队列状态。
func (service *Service) Status(ctx context.Context) (Status, error) {
	config, err := service.GetConfig(ctx)
	if err != nil {
		return Status{}, err
	}
	status := Status{Config: config}
	if config.UsernameSecretID != "" {
		if _, configured, err := service.secrets.SecretMetadata(ctx, config.UsernameSecretID); err == nil && configured {
			status.UsernameConfigured = true
		}
	}
	if config.PasswordSecretID != "" {
		if _, configured, err := service.secrets.SecretMetadata(ctx, config.PasswordSecretID); err == nil && configured {
			status.PasswordConfigured = true
		}
	}
	err = service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM modelry_mail_deliveries WHERE status IN (?, ?)", string(DeliveryPending), string(DeliveryRunning)).Scan(&status.Pending); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM modelry_mail_deliveries WHERE status = ?", string(DeliveryFailed)).Scan(&status.Failed); err != nil {
			return err
		}
		return tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM modelry_mail_deliveries WHERE status = ?", string(DeliverySucceeded)).Scan(&status.Succeeded)
	})
	if err != nil {
		return Status{}, fmt.Errorf("%w: read Mail Delivery counts: %v", ErrUnavailable, err)
	}
	return status, nil
}

var _ = errors.Is
