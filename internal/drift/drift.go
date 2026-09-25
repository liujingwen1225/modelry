// Package drift 比较 Applied Model、物理 SQLite 投影与 runtime-managed state。
// 它把「尚未 Apply 的 Pending Change」与真实不一致严格区分，并且只自动修复 Applied Model 的物理投影。
package drift

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	// ErrInvalidArgument 表示请求参数不合法。
	ErrInvalidArgument = errors.New("invalid drift argument")
	// ErrNotFound 表示目标 Collection 不存在。
	ErrNotFound = errors.New("drift target not found")
	// ErrConflict 表示修复被拒绝，例如 Collection 不是 Applied Collection。
	ErrConflict = errors.New("drift reconcile conflict")
	// ErrStorage 表示物理结构读取或修复失败。
	ErrStorage = errors.New("drift storage unavailable")
)

// Class 是一条 finding 的来源类别。
type Class string

const (
	ClassAppliedModel       Class = "appliedModel"
	ClassPhysicalProjection Class = "physicalProjection"
	ClassRuntimeState       Class = "runtimeState"
)

// Severity 是一条 finding 的严重程度。
type Severity string

const (
	SeverityInfo    Severity = "info"
	SeverityWarning Severity = "warning"
	SeverityError   Severity = "error"
)

// Remedy 告诉操作员如何修正一条 finding。
type Remedy string

const (
	RemedyNone      Remedy = "none"
	RemedyManual    Remedy = "manual"
	RemedyReconcile Remedy = "reconcile"
)

// Finding 是一条 Drift 结论。
type Finding struct {
	ID                    string    `json:"id"`
	Class                 Class     `json:"class"`
	Severity              Severity  `json:"severity"`
	Code                  string    `json:"code"`
	CollectionID          string    `json:"collectionId,omitempty"`
	CollectionName        string    `json:"collectionName,omitempty"`
	Expected              string    `json:"expected"`
	Actual                string    `json:"actual"`
	ExpectedPendingChange bool      `json:"expectedPendingChange"`
	Remedy                Remedy    `json:"remedy"`
	DeepLink              string    `json:"deepLink"`
	DetectedAt            time.Time `json:"detectedAt"`
}

// Report 是一次完整的 Drift 结论。
type Report struct {
	State      string    `json:"state"`
	Findings   []Finding `json:"findings"`
	DetectedAt time.Time `json:"detectedAt"`
}

// AuditSink 由 Runtime 注入：在修复事务内写入 Control Plane 事实。
type AuditSink interface {
	AppendDriftFactInTransaction(ctx context.Context, tx storage.Executor, action, resourceID, result string) error
}

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

type appliedModelSource interface {
	ListCollections(context.Context, backendmodel.ListOptions) (backendmodel.Page[backendmodel.Collection], error)
}

// Service 提供 Drift 报告与投影修复。
type Service struct {
	store  transactionalStore
	models appliedModelSource
	audits AuditSink
	now    func() time.Time
}

// NewService 创建 Drift 服务。
func NewService(store transactionalStore, models *backendmodel.Service, audits AuditSink) (*Service, error) {
	if store == nil || models == nil {
		return nil, fmt.Errorf("%w: Drift requires the SQLite store and the backend model", ErrInvalidArgument)
	}
	return &Service{store: store, models: models, audits: audits, now: func() time.Time { return time.Now().UTC() }}, nil
}

const (
	maximumCollections   = 512
	maximumFindings      = 2048
	collectionPageSize   = 100
	orphanProjectionTips = "no Applied Collection declares this projection table"
)

// Report 计算当前 Drift 报告。collectionID 为空时检查全部 Applied Collection。
func (service *Service) Report(ctx context.Context, collectionID string) (Report, error) {
	if service == nil || service.store == nil {
		return Report{}, fmt.Errorf("%w: Drift service is not ready", ErrStorage)
	}
	collections, err := service.appliedCollections(ctx)
	if err != nil {
		return Report{}, err
	}
	if trimmed := strings.TrimSpace(collectionID); trimmed != "" {
		filtered := make([]backendmodel.Collection, 0, 1)
		for _, collection := range collections {
			if collection.ID == trimmed {
				filtered = append(filtered, collection)
			}
		}
		if len(filtered) == 0 {
			return Report{}, ErrNotFound
		}
		collections = filtered
	}
	now := service.now().UTC()
	findings := make([]Finding, 0, 16)
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		for _, collection := range collections {
			diff, err := storage.DiffRecordProjection(ctx, snapshot, backendmodel.StorageRecordProjection(collection))
			if err != nil {
				return err
			}
			findings = append(findings, projectionFindings(collection, diff, now)...)
		}
		runtimeFindings, err := service.runtimeFindings(ctx, snapshot, collections, now)
		if err != nil {
			return err
		}
		findings = append(findings, runtimeFindings...)
		return nil
	})
	if err != nil {
		return Report{}, wrapStorage(err)
	}
	report := Report{State: stateFor(findings), Findings: capFindings(findings), DetectedAt: now}
	return report, nil
}

func (service *Service) appliedCollections(ctx context.Context) ([]backendmodel.Collection, error) {
	collections := make([]backendmodel.Collection, 0, 16)
	cursor := ""
	for len(collections) < maximumCollections {
		page, err := service.models.ListCollections(ctx, backendmodel.ListOptions{Limit: collectionPageSize, Cursor: cursor})
		if err != nil {
			return nil, wrapStorage(err)
		}
		collections = append(collections, page.Data...)
		if page.NextCursor == "" || len(page.Data) == 0 {
			break
		}
		cursor = page.NextCursor
	}
	return collections, nil
}

func projectionFindings(collection backendmodel.Collection, diff storage.RecordProjectionDiff, now time.Time) []Finding {
	name := collection.Name
	schemaLink := "/collections/" + collection.ID + "/schema"
	findings := make([]Finding, 0, 4)
	if diff.TableMissing {
		findings = append(findings, Finding{
			ID: "df_table_missing_" + collection.ID, Class: ClassPhysicalProjection, Severity: SeverityError,
			Code: "physicalProjection.tableMissing", CollectionID: collection.ID, CollectionName: name,
			Expected: "record projection table for the applied model", Actual: "no record table exists",
			Remedy: RemedyReconcile, DeepLink: schemaLink, DetectedAt: now,
		})
		return findings
	}
	for _, column := range diff.MissingColumns {
		findings = append(findings, Finding{
			ID: "df_column_missing_" + collection.ID + "_" + column.Column, Class: ClassPhysicalProjection, Severity: SeverityWarning,
			Code: "physicalProjection.columnMissing", CollectionID: collection.ID, CollectionName: name,
			Expected: "column " + column.Column + " (" + column.Expected + ")", Actual: "column is absent",
			Remedy: RemedyReconcile, DeepLink: schemaLink, DetectedAt: now,
		})
	}
	for _, column := range diff.TypeMismatches {
		findings = append(findings, Finding{
			ID: "df_column_type_" + collection.ID + "_" + column.Column, Class: ClassPhysicalProjection, Severity: SeverityWarning,
			Code: "physicalProjection.columnTypeMismatch", CollectionID: collection.ID, CollectionName: name,
			Expected: "column " + column.Column + " (" + column.Expected + ")", Actual: "column is " + column.Actual,
			Remedy: RemedyManual, DeepLink: schemaLink, DetectedAt: now,
		})
	}
	for _, index := range diff.MissingIndexes {
		findings = append(findings, Finding{
			ID: "df_index_missing_" + collection.ID + "_" + index, Class: ClassPhysicalProjection, Severity: SeverityWarning,
			Code: "physicalProjection.indexMissing", CollectionID: collection.ID, CollectionName: name,
			Expected: "index " + index, Actual: "index is absent",
			Remedy: RemedyReconcile, DeepLink: schemaLink, DetectedAt: now,
		})
	}
	return findings
}

func (service *Service) runtimeFindings(ctx context.Context, snapshot storage.Executor, collections []backendmodel.Collection, now time.Time) ([]Finding, error) {
	findings := make([]Finding, 0, 4)
	known := map[string]backendmodel.Collection{}
	for _, collection := range collections {
		known[collection.ID] = collection
	}

	rows, err := snapshot.QueryContext(ctx, `SELECT ch.id, ch.collection_id, ch.status, COALESCE(c.name, '')
		FROM modelry_backend_changes ch
		LEFT JOIN modelry_backend_collections c ON c.id = ch.collection_id
		WHERE ch.status IN ('ready', 'needsReview', 'failed')`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, collectionID, status, name string
		if err := rows.Scan(&id, &collectionID, &status, &name); err != nil {
			rows.Close()
			return nil, err
		}
		if status == "failed" {
			findings = append(findings, Finding{
				ID: "df_change_failed_" + id, Class: ClassRuntimeState, Severity: SeverityWarning,
				Code: "runtimeState.changeFailed", CollectionID: collectionID, CollectionName: name,
				Expected: "the last change either applied or was resolved", Actual: "the saved change failed",
				Remedy: RemedyManual, DeepLink: "/changes?changeSet=" + id, DetectedAt: now,
			})
			continue
		}
		findings = append(findings, Finding{
			ID: "df_change_pending_" + id, Class: ClassAppliedModel, Severity: SeverityInfo,
			Code: "appliedModel.pendingChange", CollectionID: collectionID, CollectionName: name,
			Expected: "this change is intentionally not applied yet", Actual: "a saved change is waiting for review",
			ExpectedPendingChange: true, Remedy: RemedyManual,
			DeepLink: "/collections/" + collectionID + "/schema", DetectedAt: now,
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	attemptRows, err := snapshot.QueryContext(ctx, `SELECT a.id, a.change_set_id, a.status, COALESCE(ch.collection_id, ''), COALESCE(c.name, '')
		FROM modelry_backend_apply_attempts a
		LEFT JOIN modelry_backend_changes ch ON ch.id = a.change_set_id
		LEFT JOIN modelry_backend_collections c ON c.id = ch.collection_id
		WHERE a.status IN ('inProgress', 'interrupted', 'recoveryRequired')`)
	if err != nil {
		return nil, err
	}
	for attemptRows.Next() {
		var id, changeSetID, status, collectionID, name string
		if err := attemptRows.Scan(&id, &changeSetID, &status, &collectionID, &name); err != nil {
			attemptRows.Close()
			return nil, err
		}
		link := "/changes?changeSet=" + changeSetID
		if collectionID != "" {
			link = "/collections/" + collectionID + "/schema"
		}
		findings = append(findings, Finding{
			ID: "df_apply_" + id, Class: ClassRuntimeState, Severity: SeverityWarning,
			Code: "runtimeState.applyInterrupted", CollectionID: collectionID, CollectionName: name,
			Expected: "the last apply attempt finished", Actual: "the apply attempt is " + status,
			Remedy: RemedyManual, DeepLink: link, DetectedAt: now,
		})
	}
	if err := attemptRows.Err(); err != nil {
		attemptRows.Close()
		return nil, err
	}
	attemptRows.Close()

	tableRows, err := snapshot.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mry_records_%'`)
	if err != nil {
		return nil, err
	}
	orphans := make([]string, 0, 4)
	for tableRows.Next() {
		var name string
		if err := tableRows.Scan(&name); err != nil {
			tableRows.Close()
			return nil, err
		}
		collectionID := "col_" + strings.TrimPrefix(name, "mry_records_")
		if _, found := known[collectionID]; found {
			continue
		}
		orphans = append(orphans, name)
	}
	if err := tableRows.Err(); err != nil {
		tableRows.Close()
		return nil, err
	}
	tableRows.Close()
	sort.Strings(orphans)
	for _, name := range orphans {
		findings = append(findings, Finding{
			ID: "df_orphan_" + name, Class: ClassRuntimeState, Severity: SeverityWarning,
			Code: "runtimeState.orphanProjection", Expected: "every record table belongs to an Applied Collection",
			Actual: "table " + name + " has " + orphanProjectionTips, Remedy: RemedyManual,
			DeepLink: "/collections", DetectedAt: now,
		})
	}
	return findings, nil
}

// Reconcile 只重建一个 Collection 的 Applied Model 物理投影，并写入 Audit fact。
func (service *Service) Reconcile(ctx context.Context, collectionID string) error {
	trimmed := strings.TrimSpace(collectionID)
	if trimmed == "" || len(trimmed) > 128 {
		return fmt.Errorf("%w: collectionId is required", ErrInvalidArgument)
	}
	collections, err := service.appliedCollections(ctx)
	if err != nil {
		return err
	}
	var target backendmodel.Collection
	found := false
	for _, collection := range collections {
		if collection.ID == trimmed {
			target, found = collection, true
			break
		}
	}
	if !found {
		return ErrNotFound
	}
	projection := backendmodel.StorageRecordProjection(target)
	return wrapStorage(service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		exists, err := storage.RecordProjectionExists(ctx, tx, target.ID)
		if err != nil {
			return err
		}
		if !exists {
			if err := storage.CreateRecordProjection(ctx, tx, projection); err != nil {
				return err
			}
		} else {
			if _, _, err := storage.AddMissingRecordProjectionColumns(ctx, tx, projection); err != nil {
				return err
			}
			if _, err := storage.CreateMissingRecordProjectionIndexes(ctx, tx, projection); err != nil {
				return err
			}
		}
		if service.audits != nil {
			if err := service.audits.AppendDriftFactInTransaction(ctx, tx, "drift.reconciled", target.ID, "success"); err != nil {
				return err
			}
		}
		return nil
	}))
}

func stateFor(findings []Finding) string {
	state := "healthy"
	for _, finding := range findings {
		switch finding.Severity {
		case SeverityError:
			return "degraded"
		case SeverityWarning:
			state = "attention"
		}
	}
	return state
}

func capFindings(findings []Finding) []Finding {
	sort.SliceStable(findings, func(left, right int) bool {
		if findings[left].Severity != findings[right].Severity {
			return severityRank(findings[left].Severity) > severityRank(findings[right].Severity)
		}
		return findings[left].ID < findings[right].ID
	})
	if len(findings) > maximumFindings {
		findings = findings[:maximumFindings]
	}
	if findings == nil {
		findings = []Finding{}
	}
	return findings
}

func severityRank(severity Severity) int {
	switch severity {
	case SeverityError:
		return 3
	case SeverityWarning:
		return 2
	default:
		return 1
	}
}

func wrapStorage(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrInvalidArgument) || errors.Is(err, ErrConflict) {
		return err
	}
	return fmt.Errorf("%w: %v", ErrStorage, err)
}

var _ = sql.ErrNoRows