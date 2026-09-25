package automation

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func (service *Service) CreateTestDelivery(ctx context.Context, webhookID string) (Delivery, error) {
	id, err := newResourceID("dlv_")
	if err != nil {
		return Delivery{}, err
	}
	testID, err := newResourceID("tst_")
	if err != nil {
		return Delivery{}, err
	}
	now := service.now().UTC()
	payload, err := json.Marshal(map[string]any{
		"deliveryId": id,
		"event":      map[string]any{"type": "webhook.test", "testId": testID, "occurredAt": now.Format(time.RFC3339Nano)},
	})
	if err != nil {
		return Delivery{}, errors.New("cannot encode synthetic Webhook test payload")
	}
	var item Delivery
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var secretID string
		if err := tx.QueryRowContext(ctx, `SELECT signing_secret_id FROM modelry_automation_webhooks WHERE id=?`, webhookID).Scan(&secretID); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var configured int
		if err := tx.QueryRowContext(ctx, `SELECT length(value_cipher)>0 FROM modelry_secrets WHERE id=?`, secretID).Scan(&configured); errors.Is(err, sql.ErrNoRows) {
			return invalidField("/signingSecretId", "invalidSecretReference", "Choose a configured Project Secret before sending a test.")
		} else if err != nil {
			return err
		} else if configured != 1 {
			return invalidField("/signingSecretId", "invalidSecretReference", "Choose a configured Project Secret before sending a test.")
		}
		var err error
		item, err = service.createDeliveryInTransaction(ctx, tx, deliveryIntent{
			id: id, sourceType: "test", sourceID: testID, webhookID: webhookID, eventType: "webhook.test", payload: payload, allowOff: true,
		})
		return err
	})
	if err == nil {
		service.signal()
	}
	return item, err
}

func (service *Service) GetDelivery(ctx context.Context, deliveryID string) (Delivery, error) {
	var item Delivery
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var ordinal int64
		if err := scanDelivery(snapshot.QueryRowContext(ctx, deliverySummarySQL+` WHERE d.id=?`, deliveryID), &item, &ordinal); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		rows, err := snapshot.QueryContext(ctx, `SELECT round,attempt,webhook_revision,status,started_at,completed_at,duration_ms,http_status,error_code FROM modelry_automation_delivery_attempts WHERE delivery_id=? ORDER BY attempt LIMIT 32`, deliveryID)
		if err != nil {
			return err
		}
		defer rows.Close()
		item.Attempts = make([]DeliveryAttempt, 0)
		attemptNumbers := make(map[int]int)
		for rows.Next() {
			var attempt DeliveryAttempt
			var globalAttempt int
			var started string
			var completed sql.NullString
			var httpStatus sql.NullInt64
			if err := rows.Scan(&attempt.Round, &globalAttempt, &attempt.WebhookRevision, &attempt.Status, &started, &completed, &attempt.DurationMS, &httpStatus, &attempt.ErrorCode); err != nil {
				return err
			}
			attemptNumbers[attempt.Round]++
			attempt.Attempt = attemptNumbers[attempt.Round]
			attempt.StartedAt = parseTime(started)
			if completed.Valid {
				parsed := parseTime(completed.String)
				attempt.CompletedAt = &parsed
			}
			if httpStatus.Valid {
				value := int(httpStatus.Int64)
				attempt.HTTPStatus = &value
			}
			item.Attempts = append(item.Attempts, attempt)
		}
		return rows.Err()
	})
	return item, err
}

func (service *Service) ListDeliveries(ctx context.Context, options DeliveryListOptions) (DeliveryPage, error) {
	if options.Limit == 0 {
		options.Limit = 50
	}
	if options.Limit < 1 || options.Limit > 100 ||
		(options.SourceType != "" && options.SourceType != "eventHook" && options.SourceType != "job" && options.SourceType != "test") ||
		(options.Status != "" && options.Status != "pending" && options.Status != "running" && options.Status != "succeeded" && options.Status != "failed" && options.Status != "cancelled") {
		return DeliveryPage{}, ErrInvalidArgument
	}
	var before *deliveryCursor
	if options.Cursor != "" {
		parsed, err := decodeDeliveryCursor(options.Cursor)
		if err != nil {
			return DeliveryPage{}, ErrInvalidArgument
		}
		before = &parsed
	}
	query := deliverySummarySQL + " WHERE 1=1"
	arguments := make([]any, 0, 8)
	if options.SourceType != "" {
		query += " AND d.source_type=?"
		arguments = append(arguments, options.SourceType)
	}
	if options.Status != "" {
		query += " AND d.status=?"
		arguments = append(arguments, options.Status)
	}
	if before != nil {
		query += " AND d.ordinal<?"
		arguments = append(arguments, before.ordinal)
	}
	query += " ORDER BY d.ordinal DESC LIMIT ?"
	arguments = append(arguments, options.Limit+1)
	page := DeliveryPage{Data: make([]Delivery, 0, options.Limit)}
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		rows, err := snapshot.QueryContext(ctx, query, arguments...)
		if err != nil {
			return err
		}
		defer rows.Close()
		ordinals := make([]int64, 0, options.Limit+1)
		for rows.Next() {
			var item Delivery
			var ordinal int64
			if err := scanDelivery(rows, &item, &ordinal); err != nil {
				return err
			}
			page.Data = append(page.Data, item)
			ordinals = append(ordinals, ordinal)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(page.Data) > options.Limit {
			page.Data = page.Data[:options.Limit]
			ordinals = ordinals[:options.Limit]
			page.NextCursor = encodeDeliveryCursor(deliveryCursor{ordinal: ordinals[len(ordinals)-1]})
		}
		return nil
	})
	return page, err
}

func (service *Service) RetryDelivery(ctx context.Context, deliveryID string) (Delivery, error) {
	now := service.now().UTC()
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var status string
		var payload []byte
		var webhookID string
		var attempts, redrives int
		if err := tx.QueryRowContext(ctx, `SELECT status,payload,webhook_id,attempt_count,manual_redrive_count FROM modelry_automation_deliveries WHERE id=?`, deliveryID).
			Scan(&status, &payload, &webhookID, &attempts, &redrives); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if status != "failed" || len(payload) == 0 || attempts >= 32 || redrives >= 3 {
			return ErrNotRetryable
		}
		var targetURL, secretID string
		var enabled, configured int
		var revision int64
		if err := tx.QueryRowContext(ctx, `SELECT target_url,signing_secret_id,enabled,revision FROM modelry_automation_webhooks WHERE id=?`, webhookID).
			Scan(&targetURL, &secretID, &enabled, &revision); errors.Is(err, sql.ErrNoRows) {
			return ErrNotRetryable
		} else if err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(length(value_cipher)>0,0) FROM modelry_secrets WHERE id=?`, secretID).Scan(&configured); errors.Is(err, sql.ErrNoRows) {
			return ErrNotRetryable
		} else if err != nil {
			return err
		}
		if enabled != 1 || configured != 1 {
			return ErrNotRetryable
		}
		var pending int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_automation_deliveries WHERE status IN ('pending','running')`).Scan(&pending); err != nil {
			return err
		}
		if pending >= maximumPendingDeliveries {
			return ErrDeliveryCapacity
		}
		var round int
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(round),0)+1 FROM modelry_automation_delivery_rounds WHERE delivery_id=?`, deliveryID).Scan(&round); err != nil {
			return err
		}
		if round > 4 {
			return ErrNotRetryable
		}
		stamp := now.Format(time.RFC3339Nano)
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_delivery_rounds(delivery_id,round,webhook_revision,target_url,secret_id,attempts_started,created_at) VALUES(?,?,?,?,?,0,?)`, deliveryID, round, revision, targetURL, secretID, stamp); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE modelry_automation_deliveries SET status='pending',next_attempt_at=?,completed_at=NULL,manual_redrive_count=manual_redrive_count+1,error_code='none' WHERE id=? AND status='failed' AND manual_redrive_count=?`, stamp, deliveryID, redrives)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return ErrNotRetryable
		}
		return nil
	})
	if err != nil {
		return Delivery{}, err
	}
	service.signal()
	return service.GetDelivery(ctx, deliveryID)
}

const deliverySummarySQL = `SELECT d.ordinal,d.id,d.source_type,d.source_id,d.webhook_id,w.name,d.webhook_revision,d.event_id,d.event_type,d.status,d.created_at,d.next_attempt_at,d.completed_at,d.attempt_count,d.manual_redrive_count,d.last_http_status,d.error_code FROM modelry_automation_deliveries d JOIN modelry_automation_webhooks w ON w.id=d.webhook_id`

type deliveryScanner interface{ Scan(...any) error }

func scanDelivery(scanner deliveryScanner, item *Delivery, ordinal *int64) error {
	var eventID, next, completed sql.NullString
	var httpStatus sql.NullInt64
	var created string
	if err := scanner.Scan(ordinal, &item.ID, &item.SourceType, &item.SourceID, &item.WebhookID, &item.WebhookName, &item.WebhookRevision, &eventID, &item.EventType, &item.Status, &created, &next, &completed, &item.AttemptCount, &item.ManualRedriveCount, &httpStatus, &item.ErrorCode); err != nil {
		return err
	}
	item.CreatedAt = parseTime(created)
	if eventID.Valid {
		item.EventID = eventID.String
	}
	if next.Valid {
		item.NextAttemptAt = nullableTime(next)
	}
	if completed.Valid {
		item.CompletedAt = nullableTime(completed)
	}
	if httpStatus.Valid {
		value := int(httpStatus.Int64)
		item.LastHTTPStatus = &value
	}
	return nil
}

type deliveryCursor struct {
	ordinal int64
}

func encodeDeliveryCursor(cursor deliveryCursor) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(cursor.ordinal, 10)))
}

func decodeDeliveryCursor(value string) (deliveryCursor, error) {
	if len(value) == 0 || len(value) > 512 {
		return deliveryCursor{}, ErrInvalidArgument
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return deliveryCursor{}, ErrInvalidArgument
	}
	ordinal, err := strconv.ParseInt(string(decoded), 10, 64)
	if err != nil || ordinal < 1 || strconv.FormatInt(ordinal, 10) != string(decoded) {
		return deliveryCursor{}, ErrInvalidArgument
	}
	return deliveryCursor{ordinal: ordinal}, nil
}
