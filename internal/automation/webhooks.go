package automation

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func (service *Service) ReplaceWebhook(ctx context.Context, webhookID string, input WebhookInput) (Webhook, error) {
	input.Name = strings.TrimSpace(input.Name)
	if err := validateName(input.Name, "/name"); err != nil {
		return Webhook{}, err
	}
	targetURL, err := validateTargetURL(input.TargetURL)
	if err != nil {
		return Webhook{}, err
	}
	if input.SigningSecretID == "" {
		return Webhook{}, invalidField("/signingSecretId", "invalidSecretReference", "Select a configured Project Secret.")
	}
	now := service.now().UTC().Format(time.RFC3339Nano)
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var exists int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_automation_webhooks WHERE id=?`, webhookID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var configured int
		if err := tx.QueryRowContext(ctx, `SELECT length(value_cipher)>0 FROM modelry_secrets WHERE id=?`, input.SigningSecretID).Scan(&configured); errors.Is(err, sql.ErrNoRows) {
			return invalidField("/signingSecretId", "invalidSecretReference", "Select a configured Project Secret.")
		} else if err != nil {
			return err
		} else if configured != 1 {
			return invalidField("/signingSecretId", "invalidSecretReference", "Select a configured Project Secret.")
		}
		result, err := tx.ExecContext(ctx, `UPDATE modelry_automation_webhooks SET name=?,target_url=?,signing_secret_id=?,revision=revision+1,updated_at=? WHERE id=?`, input.Name, targetURL, input.SigningSecretID, now, webhookID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return Webhook{}, err
	}
	return service.GetWebhook(ctx, webhookID)
}

func (service *Service) EnableWebhook(ctx context.Context, webhookID string) (WebhookStatus, error) {
	var result WebhookStatus
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var secretID string
		if err := tx.QueryRowContext(ctx, `SELECT signing_secret_id FROM modelry_automation_webhooks WHERE id=?`, webhookID).Scan(&secretID); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var configured int
		if err := tx.QueryRowContext(ctx, `SELECT length(value_cipher)>0 FROM modelry_secrets WHERE id=?`, secretID).Scan(&configured); errors.Is(err, sql.ErrNoRows) {
			return invalidField("/signingSecretId", "invalidSecretReference", "Select a configured Project Secret before enabling this Webhook.")
		} else if err != nil {
			return err
		} else if configured != 1 {
			return invalidField("/signingSecretId", "invalidSecretReference", "Select a configured Project Secret before enabling this Webhook.")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_automation_webhooks SET enabled=1,updated_at=? WHERE id=?`, service.now().UTC().Format(time.RFC3339Nano), webhookID); err != nil {
			return err
		}
		result = WebhookStatus{ID: webhookID, Enabled: true}
		return nil
	})
	return result, err
}

func (service *Service) DisableWebhook(ctx context.Context, webhookID string) (WebhookStatus, error) {
	var result WebhookStatus
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		resultSet, err := tx.ExecContext(ctx, `UPDATE modelry_automation_webhooks SET enabled=0,updated_at=? WHERE id=?`, service.now().UTC().Format(time.RFC3339Nano), webhookID)
		if err != nil {
			return err
		}
		count, err := resultSet.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
		if err := service.cancelUnstartedInTransaction(ctx, tx, webhookID, "webhookDisabled", false); err != nil {
			return err
		}
		result = WebhookStatus{ID: webhookID, Enabled: false}
		return nil
	})
	if err == nil {
		service.cancelWebhook(webhookID, false)
	}
	return result, err
}

func (service *Service) cancelUnstartedInTransaction(ctx context.Context, tx storage.Executor, webhookID, code string, includeTests bool) error {
	sourceFilter := "source_type IN ('eventHook','job','test')"
	if !includeTests {
		sourceFilter = "source_type IN ('eventHook','job')"
	}
	_, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='cancelled',completed_at=?,next_attempt_at=NULL,error_code=? WHERE webhook_id=? AND `+sourceFilter+` AND status='pending'`, service.now().UTC().Format(time.RFC3339Nano), code, webhookID)
	return err
}

func (service *Service) RevokeSecretInTransaction(ctx context.Context, tx storage.Executor, secretID string) error {
	if _, err := tx.ExecContext(ctx, `UPDATE modelry_automation_webhooks SET enabled=0,updated_at=? WHERE signing_secret_id=?`, service.now().UTC().Format(time.RFC3339Nano), secretID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='cancelled',completed_at=?,next_attempt_at=NULL,error_code='secretRevoked'
		WHERE webhook_id IN (SELECT id FROM modelry_automation_webhooks WHERE signing_secret_id=?) AND status='pending'`, service.now().UTC().Format(time.RFC3339Nano), secretID)
	return err
}

func (service *Service) SecretRevoked(secretID string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	webhookIDs := make([]string, 0)
	_ = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		rows, err := snapshot.QueryContext(ctx, `SELECT id FROM modelry_automation_webhooks WHERE signing_secret_id=?`, secretID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			webhookIDs = append(webhookIDs, id)
		}
		return rows.Err()
	})
	for _, webhookID := range webhookIDs {
		service.cancelWebhook(webhookID, true)
	}
}

func (service *Service) cancelWebhook(webhookID string, includeTests bool) {
	service.mu.Lock()
	defer service.mu.Unlock()
	for _, active := range service.active {
		if active.webhookID == webhookID && (includeTests || active.sourceType != "test") {
			active.cancel()
		}
	}
}

func (service *Service) registerActive(id, webhookID, sourceType string, cancel context.CancelFunc) {
	service.mu.Lock()
	service.active[id] = activeDelivery{webhookID: webhookID, sourceType: sourceType, cancel: cancel}
	service.mu.Unlock()
}

func (service *Service) unregisterActive(id string) {
	service.mu.Lock()
	delete(service.active, id)
	service.mu.Unlock()
}
