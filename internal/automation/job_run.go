package automation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// RunJobOnce 为一次显式的手动运行创建一条 Job Delivery。
//
// 语义（见 docs/specs/0006-webhooks-jobs-domain-spec.md）：
// - 它不改变 Job 的计划状态：不推进 next_run_at，也不改写 last_run_at；
// - 它不触发额外槽位，因此不会跳过或补上任何计划运行；
// - 目标 Webhook 必须处于启用状态且签名 Secret 已配置，否则返回字段级校验错误；
// - 容量行为与合成 Webhook Test 一致：配额已满时仍返回一条终态 capacityExceeded Delivery，
//   不发出任何网络请求，也不消耗任何重试额度。
func (service *Service) RunJobOnce(ctx context.Context, jobID string) (Delivery, error) {
	if service == nil || service.store == nil {
		return Delivery{}, ErrInvalidArgument
	}
	id, err := newResourceID("dlv_")
	if err != nil {
		return Delivery{}, err
	}
	var item Delivery
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var webhookID string
		if err := tx.QueryRowContext(ctx, `SELECT webhook_id FROM modelry_automation_jobs WHERE id=?`, jobID).Scan(&webhookID); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var secretID string
		if err := tx.QueryRowContext(ctx, `SELECT signing_secret_id FROM modelry_automation_webhooks WHERE id=?`, webhookID).Scan(&secretID); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		var configured int
		if err := tx.QueryRowContext(ctx, `SELECT length(value_cipher)>0 FROM modelry_secrets WHERE id=?`, secretID).Scan(&configured); errors.Is(err, sql.ErrNoRows) {
			return invalidField("/signingSecretId", "invalidSecretReference", "Choose a configured Project Secret before running this Job manually.")
		} else if err != nil {
			return err
		} else if configured != 1 {
			return invalidField("/signingSecretId", "invalidSecretReference", "Choose a configured Project Secret before running this Job manually.")
		}
		triggeredAt := service.now().UTC()
		payload := []byte(fmt.Sprintf(`{"deliveryId":%q,"event":{"type":"job.manual","jobId":%q,"triggeredAt":%q}}`, id, jobID, triggeredAt.Format(time.RFC3339Nano)))
		created, err := service.createDeliveryInTransaction(ctx, tx, deliveryIntent{
			id: id, sourceType: "job", sourceID: jobID, webhookID: webhookID, eventType: "job.manual", payload: payload,
		})
		if err != nil {
			return err
		}
		item = created
		return service.appendAudit(ctx, tx, "job.runRequested", "job", jobID)
	})
	if err != nil {
		return Delivery{}, err
	}
	service.signal()
	return item, nil
}
