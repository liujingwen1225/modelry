package automation

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func (service *Service) recoverOnStartup(ctx context.Context) error {
	now := service.now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		rows, err := tx.QueryContext(ctx, `SELECT d.id,d.source_type,d.attempt_count,r.round,r.attempts_started,w.enabled,s.id,a.attempt,a.started_at
			FROM modelry_automation_deliveries d
			JOIN modelry_automation_delivery_rounds r ON r.delivery_id=d.id AND r.round=(SELECT MAX(r2.round) FROM modelry_automation_delivery_rounds r2 WHERE r2.delivery_id=d.id)
			JOIN modelry_automation_webhooks w ON w.id=d.webhook_id
			LEFT JOIN modelry_secrets s ON s.id=r.secret_id
			LEFT JOIN modelry_automation_delivery_attempts a ON a.delivery_id=d.id AND a.status='running'
			WHERE d.status='running' ORDER BY d.ordinal`)
		if err != nil {
			return err
		}
		type interruptedDelivery struct {
			id, sourceType                                     string
			attemptCount, round, roundAttempts, webhookEnabled int
			secretID, attemptStarted                           sql.NullString
			attempt                                            sql.NullInt64
		}
		pending := make([]interruptedDelivery, 0)
		for rows.Next() {
			var item interruptedDelivery
			if err := rows.Scan(&item.id, &item.sourceType, &item.attemptCount, &item.round, &item.roundAttempts, &item.webhookEnabled, &item.secretID, &item.attempt, &item.attemptStarted); err != nil {
				_ = rows.Close()
				return err
			}
			pending = append(pending, item)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, item := range pending {
			if item.attempt.Valid {
				var duration int64
				if item.attemptStarted.Valid {
					if started, err := time.Parse(time.RFC3339Nano, item.attemptStarted.String); err == nil {
						duration = now.Sub(started).Milliseconds()
						if duration < 0 {
							duration = 0
						}
					}
				}
				if _, err := tx.ExecContext(ctx, `UPDATE modelry_automation_delivery_attempts SET status='interrupted',completed_at=?,duration_ms=?,error_code='attemptInterrupted' WHERE delivery_id=? AND attempt=? AND status='running'`, stamp, duration, item.id, item.attempt.Int64); err != nil {
					return err
				}
			}
			switch {
			case !item.secretID.Valid:
				_, err = tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='cancelled',completed_at=?,next_attempt_at=NULL,error_code='secretRevoked' WHERE id=? AND status='running'`, stamp, item.id)
			case item.sourceType != "test" && item.webhookEnabled != 1:
				_, err = tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='cancelled',completed_at=?,next_attempt_at=NULL,error_code='webhookDisabled' WHERE id=? AND status='running'`, stamp, item.id)
			case item.attemptCount >= 32 || item.roundAttempts >= 8:
				_, err = tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='failed',completed_at=?,next_attempt_at=NULL,error_code='attemptInterrupted' WHERE id=? AND status='running'`, stamp, item.id)
			default:
				_, err = tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='pending',completed_at=NULL,next_attempt_at=?,error_code='attemptInterrupted' WHERE id=? AND status='running'`, stamp, item.id)
			}
			if err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='cancelled',completed_at=?,next_attempt_at=NULL,error_code='secretRevoked'
			WHERE status='pending' AND NOT EXISTS (
				SELECT 1 FROM modelry_automation_delivery_rounds r JOIN modelry_secrets s ON s.id=r.secret_id
				WHERE r.delivery_id=modelry_automation_deliveries.id AND r.round=(SELECT MAX(r2.round) FROM modelry_automation_delivery_rounds r2 WHERE r2.delivery_id=modelry_automation_deliveries.id)
			)`, stamp); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='cancelled',completed_at=?,next_attempt_at=NULL,error_code='webhookDisabled'
			WHERE status='pending' AND source_type<>'test' AND EXISTS(SELECT 1 FROM modelry_automation_webhooks w WHERE w.id=modelry_automation_deliveries.webhook_id AND w.enabled=0)`, stamp)
		return err
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	return err
}
