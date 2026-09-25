package mail

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

var errNoDelivery = errors.New("no mail delivery is ready")

func (service *Service) wakeWorker() {
	select {
	case service.wake <- struct{}{}:
	default:
	}
}

// Start 启动 bounded outbox worker；同一 Runtime 只允许启动一次。
func (service *Service) Start(parent context.Context) error {
	if parent == nil {
		parent = context.Background()
	}
	service.mu.Lock()
	if service.started || service.closed {
		service.mu.Unlock()
		return fmt.Errorf("%w: Mail outbox worker can only be started once", ErrInvalidArgument)
	}
	ctx, cancel := context.WithCancel(parent)
	service.started = true
	service.runCancel = cancel
	service.runDone = make(chan struct{})
	done := service.runDone
	service.mu.Unlock()
	go func() {
		defer close(done)
		ticker := time.NewTicker(service.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			case <-service.wake:
			}
			for processed := 0; processed < 4; processed++ {
				more, err := service.processNext(ctx)
				if err != nil || !more {
					break
				}
			}
		}
	}()
	return nil
}

// Close 取消进行中的投递尝试并等待 worker 退出。
func (service *Service) Close(ctx context.Context) error {
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		return nil
	}
	service.closed = true
	cancel := service.runCancel
	done := service.runDone
	active := make([]context.CancelFunc, 0, len(service.active))
	for _, stop := range service.active {
		active = append(active, stop)
	}
	service.mu.Unlock()
	for _, stop := range active {
		stop()
	}
	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
		}
	}
	if !service.started {
		// 从未启动时把 running 归还 pending，保持 restart-aware 语义。
		_ = service.store.WithTransaction(context.WithoutCancel(ctx), func(tx storage.Executor) error {
			_, err := tx.ExecContext(context.WithoutCancel(ctx), "UPDATE modelry_mail_deliveries SET status = ?, next_attempt_at = ? WHERE status = ? AND attempts < ?", string(DeliveryPending), service.timestamp(), string(DeliveryRunning), MaximumAttemptsPerDelivery)
			return err
		})
	}
	return nil
}

func (service *Service) processNext(ctx context.Context) (bool, error) {
	var delivery Delivery
	now := service.timestamp()
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		row := tx.QueryRowContext(ctx, "UPDATE modelry_mail_deliveries SET status = ?, next_attempt_at = NULL WHERE id = (SELECT id FROM modelry_mail_deliveries WHERE status = ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC, id ASC LIMIT 1) RETURNING id, kind, recipient, payload_ref, status, attempts, next_attempt_at, error_code, created_at, completed_at", string(DeliveryRunning), string(DeliveryPending), now)
		value, err := scanDelivery(row)
		if errors.Is(err, sql.ErrNoRows) {
			return errNoDelivery
		}
		if err != nil {
			return err
		}
		delivery = value
		return nil
	})
	if errors.Is(err, errNoDelivery) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	service.dispatch(ctx, delivery)
	return true, nil
}

func (service *Service) dispatch(ctx context.Context, delivery Delivery) {
	config, err := service.GetConfig(ctx)
	if err != nil || !config.Configured() {
		service.reschedule(ctx, delivery, ErrorProviderDisabled, false)
		return
	}
	attemptCtx, cancel := context.WithTimeout(ctx, DeliveryTimeout)
	service.mu.Lock()
	service.active[delivery.ID] = cancel
	service.mu.Unlock()
	defer func() {
		cancel()
		service.mu.Lock()
		delete(service.active, delivery.ID)
		service.mu.Unlock()
	}()
	credentials, err := service.resolveCredentials(attemptCtx, config)
	if err != nil {
		service.reschedule(ctx, delivery, ErrorCredentialMissing, false)
		return
	}
	subject, body, err := service.payloads.RenderDeliveryPayload(attemptCtx, delivery.Kind, delivery.PayloadRef, delivery.Recipient)
	if err != nil {
		service.reschedule(ctx, delivery, ErrorPayloadInvalid, true)
		return
	}
	message := Message{
		From: config.FromAddress, FromName: config.FromName, To: delivery.Recipient,
		Subject: subject, Body: body,
		MessageID: "<" + delivery.ID + "@modelry.local>", Date: service.now().UTC(),
	}
	if err := service.sender.Send(attemptCtx, config, credentials, message); err != nil {
		code := ErrorConnectFailed
		switch {
		case errors.Is(err, ErrCredentialUnavailable):
			code = ErrorAuthentication
		case errors.Is(err, ErrInvalidArgument):
			code = ErrorPayloadInvalid
		}
		service.reschedule(ctx, delivery, code, true)
		return
	}
	service.markSucceeded(ctx, delivery)
}

func (service *Service) resolveCredentials(ctx context.Context, config Config) (Credentials, error) {
	var credentials Credentials
	if err := service.secrets.WithSecretValue(ctx, config.UsernameSecretID, func(value []byte) error {
		credentials.Username = string(value)
		return nil
	}); err != nil {
		return Credentials{}, err
	}
	if err := service.secrets.WithSecretValue(ctx, config.PasswordSecretID, func(value []byte) error {
		credentials.Password = string(value)
		return nil
	}); err != nil {
		return Credentials{}, err
	}
	if credentials.Username == "" || credentials.Password == "" {
		return Credentials{}, ErrCredentialUnavailable
	}
	return credentials, nil
}

func (service *Service) markSucceeded(ctx context.Context, delivery Delivery) {
	now := service.timestamp()
	_ = service.store.WithTransaction(context.WithoutCancel(ctx), func(tx storage.Executor) error {
		_, err := tx.ExecContext(context.WithoutCancel(ctx), "UPDATE modelry_mail_deliveries SET status = ?, attempts = ?, error_code = '', completed_at = ?, next_attempt_at = NULL WHERE id = ?", string(DeliverySucceeded), delivery.Attempts+1, now, delivery.ID)
		return err
	})
}

// reschedule 记录一次尝试结果；burnAttempt 为 false 时保留尝试预算（例如 Provider 未启用）。
func (service *Service) reschedule(ctx context.Context, delivery Delivery, errorCode string, burnAttempt bool) {
	attempts := delivery.Attempts
	if burnAttempt {
		attempts++
	}
	now := service.now().UTC()
	status := DeliveryPending
	var nextAttempt *time.Time
	var completedAt *time.Time
	if burnAttempt && attempts >= MaximumAttemptsPerDelivery {
		status = DeliveryFailed
		errorCode = ErrorAttemptExhausted
		completedAt = &now
	} else {
		backoff := service.interval * time.Duration(max(1, attempts))
		value := now.Add(backoff)
		nextAttempt = &value
	}
	_ = service.store.WithTransaction(context.WithoutCancel(ctx), func(tx storage.Executor) error {
		var nextValue any
		if nextAttempt != nil {
			nextValue = nextAttempt.Unix()
		}
		var completedValue any
		if completedAt != nil {
			completedValue = completedAt.Unix()
		}
		_, err := tx.ExecContext(context.WithoutCancel(ctx), "UPDATE modelry_mail_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, error_code = ?, completed_at = ? WHERE id = ?", string(status), attempts, nextValue, errorCode, completedValue, delivery.ID)
		return err
	})
}
