package automation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

const maximumJobs = 32

func (service *Service) CreateJob(ctx context.Context, input JobInput) (Job, error) {
	input.Name = trimName(input.Name)
	if err := validateName(input.Name, "/name"); err != nil {
		return Job{}, err
	}
	schedule, err := parseSchedule(input.Cron)
	if err != nil {
		return Job{}, err
	}
	now := service.now().UTC()
	next := schedule.Next(now)
	if next.IsZero() {
		return Job{}, invalidField("/cron", "invalidCron", "Choose a Cron expression with at least one reachable UTC run time.")
	}
	if input.WebhookID == "" {
		return Job{}, invalidField("/webhookId", "invalidWebhook", "Choose an existing Webhook.")
	}
	id, err := newResourceID("job_")
	if err != nil {
		return Job{}, err
	}
	stamp := now.Format(time.RFC3339Nano)
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var exists int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_automation_webhooks WHERE id=?`, input.WebhookID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_automation_jobs`).Scan(&count); err != nil {
			return err
		}
		if count >= maximumJobs {
			return invalidField("/name", "tooManyJobs", "A Project can have at most 32 Jobs.")
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_automation_jobs(id,name,webhook_id,cron,enabled,next_run_at,last_run_at,created_at,updated_at) VALUES(?,?,?,?,0,?,NULL,?,?)`, id, input.Name, input.WebhookID, input.Cron, next.Format(time.RFC3339Nano), stamp, stamp)
		return err
	})
	if err != nil {
		return Job{}, err
	}
	return service.GetJob(ctx, id)
}

func (service *Service) ReplaceJob(ctx context.Context, jobID string, input JobInput) (Job, error) {
	input.Name = trimName(input.Name)
	if err := validateName(input.Name, "/name"); err != nil {
		return Job{}, err
	}
	schedule, err := parseSchedule(input.Cron)
	if err != nil {
		return Job{}, err
	}
	now := service.now().UTC()
	next := schedule.Next(now)
	if next.IsZero() {
		return Job{}, invalidField("/cron", "invalidCron", "Choose a Cron expression with at least one reachable UTC run time.")
	}
	if input.WebhookID == "" {
		return Job{}, invalidField("/webhookId", "invalidWebhook", "Choose an existing Webhook.")
	}
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var exists int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_automation_webhooks WHERE id=?`, input.WebhookID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE modelry_automation_jobs SET name=?,webhook_id=?,cron=?,next_run_at=?,updated_at=? WHERE id=?`, input.Name, input.WebhookID, input.Cron, next.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), jobID)
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
		return Job{}, err
	}
	return service.GetJob(ctx, jobID)
}

func (service *Service) EnableJob(ctx context.Context, jobID string) (JobStatus, error) {
	return service.setJobEnabled(ctx, jobID, true)
}

func (service *Service) DisableJob(ctx context.Context, jobID string) (JobStatus, error) {
	return service.setJobEnabled(ctx, jobID, false)
}

func (service *Service) setJobEnabled(ctx context.Context, jobID string, enabled bool) (JobStatus, error) {
	result := JobStatus{ID: jobID, Enabled: enabled}
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		status := 0
		if enabled {
			status = 1
		}
		updated, err := tx.ExecContext(ctx, `UPDATE modelry_automation_jobs SET enabled=?,updated_at=? WHERE id=?`, status, service.now().UTC().Format(time.RFC3339Nano), jobID)
		if err != nil {
			return err
		}
		count, err := updated.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrNotFound
		}
		var next string
		if err := tx.QueryRowContext(ctx, `SELECT next_run_at FROM modelry_automation_jobs WHERE id=?`, jobID).Scan(&next); err != nil {
			return err
		}
		result.NextRunAt = parseTime(next)
		return nil
	})
	return result, err
}

func (service *Service) GetJob(ctx context.Context, jobID string) (Job, error) {
	var item Job
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var enabled int
		var next, created, updated string
		var lastRun sql.NullString
		err := snapshot.QueryRowContext(ctx, `SELECT j.id,j.name,j.webhook_id,w.name,j.cron,j.enabled,j.next_run_at,j.last_run_at,
			COALESCE((SELECT d.status FROM modelry_automation_deliveries d WHERE d.source_type='job' AND d.source_id=j.id ORDER BY d.created_at DESC,d.ordinal DESC LIMIT 1),''),
			COALESCE((SELECT d.error_code FROM modelry_automation_deliveries d WHERE d.source_type='job' AND d.source_id=j.id ORDER BY d.created_at DESC,d.ordinal DESC LIMIT 1),''),
			j.created_at,j.updated_at FROM modelry_automation_jobs j JOIN modelry_automation_webhooks w ON w.id=j.webhook_id WHERE j.id=?`, jobID).
			Scan(&item.ID, &item.Name, &item.WebhookID, &item.WebhookName, &item.Cron, &enabled, &next, &lastRun, &item.LastStatus, &item.LastErrorCode, &created, &updated)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		item.Enabled = enabled == 1
		item.NextRunAt = parseTime(next)
		if lastRun.Valid {
			parsed := parseTime(lastRun.String)
			item.LastRunAt = &parsed
		}
		item.CreatedAt, item.UpdatedAt = parseTime(created), parseTime(updated)
		return nil
	})
	return item, err
}

func (service *Service) ListJobs(ctx context.Context) ([]Job, error) {
	items := make([]Job, 0)
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		rows, err := snapshot.QueryContext(ctx, `SELECT j.id,j.name,j.webhook_id,w.name,j.cron,j.enabled,j.next_run_at,j.last_run_at,
			COALESCE((SELECT d.status FROM modelry_automation_deliveries d WHERE d.source_type='job' AND d.source_id=j.id ORDER BY d.created_at DESC,d.ordinal DESC LIMIT 1),''),
			COALESCE((SELECT d.error_code FROM modelry_automation_deliveries d WHERE d.source_type='job' AND d.source_id=j.id ORDER BY d.created_at DESC,d.ordinal DESC LIMIT 1),''),
			j.created_at,j.updated_at FROM modelry_automation_jobs j JOIN modelry_automation_webhooks w ON w.id=j.webhook_id ORDER BY j.updated_at DESC,j.id LIMIT 100`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Job
			var enabled int
			var next, created, updated string
			var lastRun sql.NullString
			if err := rows.Scan(&item.ID, &item.Name, &item.WebhookID, &item.WebhookName, &item.Cron, &enabled, &next, &lastRun, &item.LastStatus, &item.LastErrorCode, &created, &updated); err != nil {
				return err
			}
			item.Enabled, item.NextRunAt = enabled == 1, parseTime(next)
			if lastRun.Valid {
				parsed := parseTime(lastRun.String)
				item.LastRunAt = &parsed
			}
			item.CreatedAt, item.UpdatedAt = parseTime(created), parseTime(updated)
			items = append(items, item)
		}
		return rows.Err()
	})
	return items, err
}

type dueJob struct {
	id        string
	webhookID string
	cron      string
	scheduled time.Time
}

func (service *Service) scheduleDueJobs(ctx context.Context, at time.Time) error {
	at = at.UTC()
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		rows, err := tx.QueryContext(ctx, `SELECT id,webhook_id,cron,next_run_at FROM modelry_automation_jobs WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at,id`, at.Format(time.RFC3339Nano))
		if err != nil {
			return err
		}
		due := make([]dueJob, 0)
		for rows.Next() {
			var item dueJob
			var scheduled string
			if err := rows.Scan(&item.id, &item.webhookID, &item.cron, &scheduled); err != nil {
				_ = rows.Close()
				return err
			}
			item.scheduled = parseTime(scheduled)
			due = append(due, item)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, item := range due {
			schedule, err := parseSchedule(item.cron)
			if err != nil {
				return fmt.Errorf("stored Job Cron no longer parses: %w", err)
			}
			next := schedule.Next(at)
			if next.IsZero() {
				return invalidField("/cron", "invalidCron", "Choose a Cron expression with at least one reachable UTC run time.")
			}
			var webhookEnabled int
			if err := tx.QueryRowContext(ctx, `SELECT enabled FROM modelry_automation_webhooks WHERE id=?`, item.webhookID).Scan(&webhookEnabled); errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			} else if err != nil {
				return err
			}
			if webhookEnabled == 1 {
				if err := service.createJobDeliveryInTransaction(ctx, tx, item); err != nil {
					return err
				}
			}
			_, err = tx.ExecContext(ctx, `UPDATE modelry_automation_jobs SET next_run_at=?,last_run_at=?,updated_at=? WHERE id=? AND enabled=1 AND next_run_at=?`,
				next.Format(time.RFC3339Nano), item.scheduled.Format(time.RFC3339Nano), at.Format(time.RFC3339Nano), item.id, item.scheduled.Format(time.RFC3339Nano))
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		service.signal()
	}
	return err
}

func trimName(value string) string {
	return strings.TrimSpace(value)
}
