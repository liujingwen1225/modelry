package automation

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/liujingwen1225/modelry/internal/extensions/safehttp"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const (
	maximumWorkers         = 4
	workerPollInterval     = 250 * time.Millisecond
	maximumAttemptDuration = 2 * time.Second
	finishPersistenceTries = 3
	finishPersistenceLimit = time.Second
	finishPersistenceDelay = 25 * time.Millisecond
	finishRecoveryMaxDelay = 5 * time.Second
)

type deliveryClaim struct {
	id              string
	sourceType      string
	sourceID        string
	webhookID       string
	eventID         string
	eventType       string
	payload         []byte
	attempt         int
	round           int
	roundAttempt    int
	webhookRevision int64
	targetURL       string
	secretID        string
}

type attemptResult struct {
	status     string
	errorCode  string
	httpStatus int
	transient  bool
}

func (service *Service) signal() {
	select {
	case service.wake <- struct{}{}:
	default:
	}
}

func (service *Service) workerLoop(ctx context.Context) {
	ticker := time.NewTicker(workerPollInterval)
	defer ticker.Stop()
	for {
		claim, found, err := service.claimDelivery(ctx)
		if err == nil && found {
			service.processAttempt(ctx, claim)
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-service.wake:
		case <-ticker.C:
		}
	}
}

func (service *Service) schedulerLoop(ctx context.Context) {
	for {
		now := time.Now().UTC()
		untilBoundary := now.Truncate(time.Minute).Add(time.Minute).Sub(now)
		timer := time.NewTimer(untilBoundary)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			_ = service.scheduleDueJobs(ctx, time.Now().UTC())
		}
	}
}

func (service *Service) claimDelivery(ctx context.Context) (claim deliveryClaim, found bool, resultErr error) {
	now := service.now().UTC()
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var eventID sql.NullString
		var payload []byte
		var attemptCount, round, roundAttempts, webhookEnabled, secretRow int
		var revision int64
		queryErr := tx.QueryRowContext(ctx, `SELECT d.id,d.source_type,d.source_id,d.webhook_id,d.event_id,d.event_type,d.payload,d.attempt_count,
			r.round,r.webhook_revision,r.target_url,r.secret_id,r.attempts_started,w.enabled,CASE WHEN s.id IS NULL THEN 0 ELSE 1 END
			FROM modelry_automation_deliveries d
			JOIN modelry_automation_delivery_rounds r ON r.delivery_id=d.id AND r.round=(SELECT MAX(r2.round) FROM modelry_automation_delivery_rounds r2 WHERE r2.delivery_id=d.id)
			JOIN modelry_automation_webhooks w ON w.id=d.webhook_id
			LEFT JOIN modelry_secrets s ON s.id=r.secret_id
			WHERE d.status='pending' AND d.next_attempt_at<=? ORDER BY d.created_at,d.ordinal LIMIT 1`, now.Format(time.RFC3339Nano)).
			Scan(&claim.id, &claim.sourceType, &claim.sourceID, &claim.webhookID, &eventID, &claim.eventType, &payload, &attemptCount,
				&round, &revision, &claim.targetURL, &claim.secretID, &roundAttempts, &webhookEnabled, &secretRow)
		if errors.Is(queryErr, sql.ErrNoRows) {
			return nil
		}
		if queryErr != nil {
			return queryErr
		}
		if eventID.Valid {
			claim.eventID = eventID.String
		}
		if (claim.sourceType != "test" && webhookEnabled != 1) || secretRow != 1 {
			code := "secretRevoked"
			if secretRow == 1 {
				code = "webhookDisabled"
			}
			_, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='cancelled',completed_at=?,next_attempt_at=NULL,error_code=? WHERE id=? AND status='pending'`, now.Format(time.RFC3339Nano), code, claim.id)
			return err
		}
		if attemptCount >= 32 || roundAttempts >= 8 {
			_, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='failed',completed_at=?,next_attempt_at=NULL,error_code='attemptInterrupted' WHERE id=? AND status='pending'`, now.Format(time.RFC3339Nano), claim.id)
			return err
		}
		if len(payload) == 0 || len(payload) > maximumDeliveryPayload {
			_, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='failed',completed_at=?,next_attempt_at=NULL,error_code='capacityExceeded' WHERE id=? AND status='pending'`, now.Format(time.RFC3339Nano), claim.id)
			return err
		}
		claim.payload = append([]byte(nil), payload...)
		claim.attempt, claim.round, claim.roundAttempt, claim.webhookRevision = attemptCount+1, round, roundAttempts+1, revision
		stamp := now.Format(time.RFC3339Nano)
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_delivery_attempts(delivery_id,attempt,round,webhook_revision,status,started_at,completed_at,duration_ms,error_code) VALUES(?,?,?,?,'running',?,NULL,0,'none')`, claim.id, claim.attempt, claim.round, claim.webhookRevision, stamp); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_automation_delivery_rounds SET attempts_started=attempts_started+1 WHERE delivery_id=? AND round=? AND attempts_started=?`, claim.id, claim.round, roundAttempts); err != nil {
			return err
		}
		updated, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='running',attempt_count=?,next_attempt_at=NULL WHERE id=? AND status='pending'`, claim.attempt, claim.id)
		if err != nil {
			return err
		}
		changed, err := updated.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return errors.New("Delivery was not claimable")
		}
		found = true
		return nil
	})
	if err != nil {
		return deliveryClaim{}, false, err
	}
	return claim, found, nil
}

func (service *Service) processAttempt(runCtx context.Context, claim deliveryClaim) {
	started := time.Now()
	activeCtx, cancel := context.WithCancel(runCtx)
	service.registerActive(claim.id, claim.webhookID, claim.sourceType, cancel)
	defer func() {
		cancel()
		service.unregisterActive(claim.id)
	}()
	deadlineCtx, deadlineCancel := context.WithTimeout(activeCtx, maximumAttemptDuration)
	defer deadlineCancel()
	if err := runCtx.Err(); err != nil {
		return
	}
	if code := service.currentDeliveryBlock(deadlineCtx, claim); code != "" {
		if runCtx.Err() == nil {
			service.persistAttemptOutcome(runCtx, claim, attemptResult{status: "cancelled", errorCode: code}, time.Since(started))
		}
		return
	}
	var httpStatus int
	var prepareErr error
	var postErr error
	secretErr := service.secrets.WithSecretValue(deadlineCtx, claim.secretID, func(secret []byte) error {
		if runCtx.Err() != nil || deadlineCtx.Err() != nil {
			return context.Canceled
		}
		if len(secret) == 0 {
			return ErrSecretNotAvailable
		}
		target, err := service.webhookClient.PrepareWebhook(deadlineCtx, claim.targetURL)
		if err != nil {
			prepareErr = err
			return err
		}
		stamp := strconv.FormatInt(service.now().UTC().Unix(), 10)
		mac := hmac.New(sha256.New, secret)
		_, _ = mac.Write([]byte(stamp + "."))
		_, _ = mac.Write(claim.payload)
		headers := make(http.Header)
		headers.Set("Content-Type", "application/json")
		headers.Set("Idempotency-Key", claim.id)
		headers.Set("X-Modelry-Delivery-Id", claim.id)
		headers.Set("X-Modelry-Signature", "t="+stamp+",v1="+fmt.Sprintf("%x", mac.Sum(nil)))
		if claim.eventID != "" {
			headers.Set("X-Modelry-Event-Id", claim.eventID)
		}
		httpStatus, postErr = target.Post(deadlineCtx, claim.payload, headers)
		return postErr
	})
	if runCtx.Err() != nil {
		return
	}
	if secretErr != nil {
		blockCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		code := service.currentDeliveryBlock(blockCtx, claim)
		cancel()
		if code != "" {
			service.persistAttemptOutcome(runCtx, claim, attemptResult{status: "cancelled", errorCode: code}, time.Since(started))
			return
		}
		if postErr != nil && errors.Is(postErr, safehttp.ErrExternalRequestFailed) {
			service.persistAttemptOutcome(runCtx, claim, attemptResult{status: "failed", errorCode: "externalRequestFailed", transient: true}, time.Since(started))
			return
		}
		if prepareErr != nil {
			code := "externalRequestFailed"
			if errors.Is(prepareErr, safehttp.ErrOriginNotAllowed) {
				code = "originNotAllowed"
			}
			service.persistAttemptOutcome(runCtx, claim, attemptResult{status: "failed", errorCode: code}, time.Since(started))
			return
		}
		code = secretFailureCode(secretErr)
		service.persistAttemptOutcome(runCtx, claim, attemptResult{status: "failed", errorCode: code}, time.Since(started))
		return
	}
	if httpStatus >= 200 && httpStatus < 300 {
		service.persistAttemptOutcome(runCtx, claim, attemptResult{status: "succeeded", httpStatus: httpStatus}, time.Since(started))
		return
	}
	if httpStatus == 408 || httpStatus == 429 || httpStatus >= 500 {
		service.persistAttemptOutcome(runCtx, claim, attemptResult{status: "failed", errorCode: "externalRequestFailed", httpStatus: httpStatus, transient: true}, time.Since(started))
		return
	}
	service.persistAttemptOutcome(runCtx, claim, attemptResult{status: "rejected", errorCode: "deliveryRejected", httpStatus: httpStatus}, time.Since(started))
}

func (service *Service) currentDeliveryBlock(ctx context.Context, claim deliveryClaim) string {
	var enabled int
	var secretExists int
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if err := snapshot.QueryRowContext(ctx, `SELECT enabled FROM modelry_automation_webhooks WHERE id=?`, claim.webhookID).Scan(&enabled); err != nil {
			return err
		}
		return snapshot.QueryRowContext(ctx, `SELECT 1 FROM modelry_secrets WHERE id=?`, claim.secretID).Scan(&secretExists)
	})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "hookFailed"
	}
	if secretExists == 0 {
		return "secretRevoked"
	}
	if claim.sourceType != "test" && enabled != 1 {
		return "webhookDisabled"
	}
	return ""
}

func secretFailureCode(err error) string {
	switch {
	case errors.Is(err, ErrSecretKeyUnavailable):
		return "secretKeyUnavailable"
	case errors.Is(err, ErrSecretNotAvailable):
		return "secretNotAvailable"
	case errors.Is(err, context.Canceled):
		return "externalRequestFailed"
	default:
		return "hookFailed"
	}
}

func (service *Service) persistAttemptOutcome(runCtx context.Context, claim deliveryClaim, outcome attemptResult, elapsed time.Duration) {
	if runCtx == nil {
		runCtx = context.Background()
	}
	completedAt := service.now().UTC()
	delay := 100 * time.Millisecond
	recovering := false
	for {
		if runCtx.Err() != nil {
			return
		}
		if err := service.finishAttemptAt(claim, outcome, elapsed, completedAt); err == nil {
			if recovering {
				log.Printf("Modelry Automation recovered Delivery %s outcome persistence", claim.id)
			}
			return
		} else {
			log.Printf("Modelry Automation could not persist Delivery %s outcome after %d attempts: %v", claim.id, finishPersistenceTries, err)
			recovering = true
		}
		timer := time.NewTimer(delay)
		select {
		case <-runCtx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return
		case <-timer.C:
		}
		if delay < finishRecoveryMaxDelay {
			delay *= 2
			if delay > finishRecoveryMaxDelay {
				delay = finishRecoveryMaxDelay
			}
		}
	}
}

func (service *Service) finishAttempt(claim deliveryClaim, outcome attemptResult, elapsed time.Duration) error {
	return service.finishAttemptAt(claim, outcome, elapsed, service.now().UTC())
}

func (service *Service) finishAttemptAt(claim deliveryClaim, outcome attemptResult, elapsed time.Duration, now time.Time) error {
	stamp := now.Format(time.RFC3339Nano)
	duration := elapsed.Milliseconds()
	if duration < 0 {
		duration = 0
	}
	var httpValue any
	if outcome.httpStatus >= 100 && outcome.httpStatus <= 599 {
		httpValue = outcome.httpStatus
	}
	persist := func(ctx context.Context) error {
		return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
			var status, errorCode string
			var nextValue, completedValue any
			status, errorCode = "failed", outcome.errorCode
			if outcome.status == "succeeded" {
				status, errorCode, completedValue = "succeeded", "none", stamp
			} else if outcome.status == "cancelled" {
				status, completedValue = "cancelled", stamp
			} else if outcome.transient && claim.roundAttempt <= len(service.retryDelays) && claim.attempt < 32 {
				status = "pending"
				nextValue = now.Add(service.retryDelays[claim.roundAttempt-1]).Format(time.RFC3339Nano)
			}
			if outcome.status == "rejected" {
				status, completedValue = "failed", stamp
			}
			if outcome.status == "failed" && !outcome.transient {
				completedValue = stamp
			}
			if outcome.transient && nextValue == nil {
				completedValue = stamp
			}
			attemptStatus := outcome.status
			if outcome.status == "failed" && outcome.transient && nextValue != nil {
				attemptStatus = "retryScheduled"
			}
			if attemptStatus == "failed" {
				attemptStatus = "failed"
			}
			if attemptStatus == "rejected" {
				attemptStatus = "rejected"
			}
			if _, err := tx.ExecContext(ctx, `UPDATE modelry_automation_delivery_attempts SET status=?,completed_at=?,duration_ms=?,http_status=?,error_code=? WHERE delivery_id=? AND attempt=? AND status='running'`, attemptStatus, stamp, duration, httpValue, errorCode, claim.id, claim.attempt); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status=?,next_attempt_at=?,completed_at=?,last_http_status=?,error_code=? WHERE id=? AND status='running'`, status, nextValue, completedValue, httpValue, errorCode, claim.id)
			return err
		})
	}
	var persistenceErr error
	for attempt := 1; attempt <= finishPersistenceTries; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), finishPersistenceLimit)
		persistenceErr = persist(ctx)
		cancel()
		if persistenceErr == nil {
			break
		}
		if attempt < finishPersistenceTries {
			time.Sleep(time.Duration(attempt) * finishPersistenceDelay)
		}
	}
	if persistenceErr != nil {
		return fmt.Errorf("persist Delivery outcome: %w", persistenceErr)
	}
	if outcome.transient && claim.roundAttempt <= len(service.retryDelays) && claim.attempt < 32 {
		service.signal()
	}
	return nil
}
