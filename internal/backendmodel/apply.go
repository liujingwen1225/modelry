package backendmodel

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

var errUniqueValuesConflict = errors.New("existing values conflict with a unique constraint")

type ApplyFailure struct {
	Code    string
	Message string
	cause   error
}

func (failure *ApplyFailure) Error() string {
	return failure.Message
}

func (failure *ApplyFailure) Unwrap() error {
	return failure.cause
}

// Apply 重新评估当前前提，耐久地启动独立尝试，再原子提交物理投影、Applied Model 与历史。
func (service *Service) Apply(ctx context.Context, collectionID string, expectedVersion int, confirmRisk bool) (ApplyResult, error) {
	if !validOpaqueID(collectionID, "col_") || expectedVersion < 1 {
		return ApplyResult{}, fmt.Errorf("%w: invalid Collection ID or expected version", ErrInvalidArgument)
	}
	attemptID, err := newID("attempt_")
	if err != nil {
		return ApplyResult{}, err
	}
	var pending PendingChange
	var evaluation SchemaPreview
	var initialFailure error
	startedAt := time.Now().UTC()
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		row, err := loadPendingForCollection(ctx, tx, collectionID)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: Collection has no Pending Change", ErrNotFound)
		}
		if err != nil {
			return err
		}
		if row.change.Version != expectedVersion {
			return fmt.Errorf("%w: Pending Change is at version %d, not %d", ErrConflict, row.change.Version, expectedVersion)
		}
		if err := ensureNoInProgressAttempt(ctx, tx, row.change.ChangeSetID); err != nil {
			return err
		}
		evaluation, err = evaluateChange(ctx, tx, collection, row.change)
		if err != nil {
			return err
		}
		if evaluation.Risk == RiskBlocked {
			if hasFailedPrecondition(evaluation, "UNIQUE_VALUES_CONFLICT") {
				initialFailure = fmt.Errorf("%w: %w", ErrChangeBlocked, errUniqueValuesConflict)
			} else {
				return fmt.Errorf("%w: fix the listed schema preconditions before applying", ErrChangeBlocked)
			}
		} else if evaluation.Risk == RiskReview && !confirmRisk {
			return fmt.Errorf("%w: review the impact and confirm this schema change", ErrChangeConfirmationRequired)
		}
		encodedEvaluation, err := json.Marshal(evaluation)
		if err != nil {
			return fmt.Errorf("encode schema Apply evaluation: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_backend_apply_attempts (id, change_set_id, status, started_at, evaluation_json) VALUES (?, ?, ?, ?, ?)`, attemptID, row.change.ChangeSetID, AttemptInProgress, timestamp(startedAt), string(encodedEvaluation)); err != nil {
			return fmt.Errorf("durably start schema Apply attempt: %w", err)
		}
		pending = row.change
		return nil
	})
	if err != nil {
		return ApplyResult{}, err
	}
	if initialFailure != nil {
		failure := service.recordApplyFailure(ctx, attemptID, pending.ChangeSetID, initialFailure)
		return ApplyResult{State: "recoveryRequired", ApplyAttemptID: attemptID, Recovery: failure.Recovery}, failure.Error
	}

	var appliedMigrationID string
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		collection, err := loadCollection(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		row, err := loadPendingForCollection(ctx, tx, collectionID)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: Pending Change was removed during Apply", ErrConflict)
		}
		if err != nil {
			return err
		}
		if row.change.ChangeSetID != pending.ChangeSetID || row.change.Version != expectedVersion {
			return fmt.Errorf("%w: Pending Change changed after Apply began", ErrConflict)
		}
		evaluation, err := evaluateChange(ctx, tx, collection, row.change)
		if err != nil {
			return err
		}
		if evaluation.Risk == RiskBlocked {
			if hasFailedPrecondition(evaluation, "UNIQUE_VALUES_CONFLICT") {
				return fmt.Errorf("%w: %w", ErrChangeBlocked, errUniqueValuesConflict)
			}
			return fmt.Errorf("%w: current records fail a schema precondition", ErrChangeBlocked)
		}
		if evaluation.Risk == RiskReview && !confirmRisk {
			return fmt.Errorf("%w: the schema risk changed while Apply was starting", ErrChangeConfirmationRequired)
		}
		target, err := applyOperations(collection, row.change.Operations)
		if err != nil {
			return err
		}
		if err := storage.RebuildRecordProjection(ctx, tx, storageProjection(collection), storageProjection(target)); err != nil {
			return err
		}
		target.SchemaVersion = collection.SchemaVersion + 1
		target.UpdatedAt = time.Now().UTC()
		modelJSON, err := json.Marshal(target)
		if err != nil {
			return fmt.Errorf("encode Applied Model: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_backend_collections SET model_json = ?, updated_at = ? WHERE id = ?`, string(modelJSON), timestamp(target.UpdatedAt), collectionID); err != nil {
			return fmt.Errorf("persist Applied Model: %w", err)
		}
		appliedMigrationID, err = newID("mig_")
		if err != nil {
			return err
		}
		committedAt := time.Now().UTC()
		diff := buildDiff(collection, target, row.change.Operations)
		diffJSON, err := json.Marshal(diff)
		if err != nil {
			return fmt.Errorf("encode immutable Applied History: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_backend_applied_migrations (id, change_set_id, collection_id, apply_attempt_id, applied_at, schema_version, diff_json, model_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, appliedMigrationID, row.change.ChangeSetID, collectionID, attemptID, timestamp(committedAt), target.SchemaVersion, string(diffJSON), string(modelJSON)); err != nil {
			return fmt.Errorf("write immutable Applied History: %w", err)
		}
		finishedAt := timestamp(committedAt)
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_backend_apply_attempts SET status = ?, finished_at = ?, evaluation_json = ?, applied_migration_id = ? WHERE id = ? AND status = ?`, AttemptSucceeded, finishedAt, mustJSON(evaluation), appliedMigrationID, attemptID, AttemptInProgress); err != nil {
			return fmt.Errorf("complete schema Apply attempt: %w", err)
		}
		row.change.Version++
		row.change.Status = ChangeApplied
		row.change.Recovery = nil
		row.change.UpdatedAt = committedAt
		if err := persistPending(ctx, tx, &row, false); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		failure := service.recordApplyFailure(ctx, attemptID, pending.ChangeSetID, err)
		return ApplyResult{State: "recoveryRequired", ApplyAttemptID: attemptID, Recovery: failure.Recovery}, failure.Error
	}
	return ApplyResult{State: "applied", AppliedMigrationID: appliedMigrationID, ApplyAttemptID: attemptID}, nil
}

func hasFailedPrecondition(evaluation SchemaPreview, code string) bool {
	for _, precondition := range evaluation.Preconditions {
		if precondition.Code == code && precondition.Status == "failed" {
			return true
		}
	}
	return false
}

type applyFailureResult struct {
	Recovery *RecoveryState
	Error    *ApplyFailure
}

func (service *Service) recordApplyFailure(ctx context.Context, attemptID, changeSetID string, cause error) applyFailureResult {
	code, message := applyFailureCode(cause)
	recovery := &RecoveryState{
		State:   "safeToRetry",
		Summary: "The Apply transaction was rolled back. The Applied Model and Records remain unchanged, and the Pending Change is retained.",
		Actions: []string{"reviewPendingChange", "editPendingChange", "retryApply", "discardPendingChange"},
	}
	finishedAt := timestamp(time.Now())
	encodedRecovery, _ := json.Marshal(recovery)
	updateErr := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE modelry_backend_apply_attempts SET status = ?, finished_at = ?, error_code = ?, recovery_json = ? WHERE id = ? AND status = ?`, AttemptFailed, finishedAt, code, string(encodedRecovery), attemptID, AttemptInProgress)
		if err != nil {
			return fmt.Errorf("persist failed schema Apply attempt: %w", err)
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("verify failed schema Apply attempt: %w", err)
		}
		if rows == 0 {
			var status string
			if err := tx.QueryRowContext(ctx, `SELECT status FROM modelry_backend_apply_attempts WHERE id = ?`, attemptID).Scan(&status); err != nil {
				return fmt.Errorf("read schema Apply attempt outcome: %w", err)
			}
			if status == string(AttemptSucceeded) {
				return fmt.Errorf("Apply committed but the caller observed a later error; inspect immutable Applied History")
			}
			return fmt.Errorf("schema Apply attempt is no longer in progress (status %s)", status)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_backend_changes SET status = ?, recovery_json = ?, updated_at = ? WHERE id = ? AND status IN (?, ?, ?)`, ChangeFailed, string(encodedRecovery), finishedAt, changeSetID, ChangeReady, ChangeNeedsReview, ChangeFailed); err != nil {
			return fmt.Errorf("retain failed Pending Change: %w", err)
		}
		return nil
	})
	if updateErr != nil {
		message = "Apply did not complete and its recovery details could not be recorded; inspect the Pending Change before retrying"
		return applyFailureResult{Recovery: recovery, Error: &ApplyFailure{Code: "INTERNAL_ERROR", Message: message, cause: errors.Join(cause, updateErr)}}
	}
	return applyFailureResult{Recovery: recovery, Error: &ApplyFailure{Code: code, Message: message, cause: cause}}
}

func applyFailureCode(err error) (string, string) {
	switch {
	case errors.Is(err, errUniqueValuesConflict):
		return "VALIDATION_FAILED", "Repeated values block the requested Unique field. Review the failed checks, correct the conflicting values, then retry."
	case errors.Is(err, ErrChangeBlocked):
		return "VALIDATION_FAILED", "Current data or schema preconditions block this change. Review the failed checks, correct their causes, then retry."
	case errors.Is(err, ErrChangeConfirmationRequired):
		return "CHANGE_CONFIRMATION_REQUIRED", "Review the current impact and confirm the schema change before applying"
	case errors.Is(err, ErrConflict):
		return "CONFLICT", "The Pending Change changed while Apply was running. Reload it and review the latest version."
	case strings.Contains(strings.ToLower(err.Error()), "unique") || strings.Contains(strings.ToLower(err.Error()), "constraint"):
		return "VALIDATION_FAILED", "Existing Records conflict with the requested schema change. Review the Pending Change and correct the conflicting values."
	default:
		return "INTERNAL_ERROR", "Schema Apply did not complete and was rolled back. Review the recovery details before retrying."
	}
}

func (service *Service) Discard(ctx context.Context, collectionID string, expectedVersion int) (PendingChange, error) {
	if !validOpaqueID(collectionID, "col_") || expectedVersion < 1 {
		return PendingChange{}, fmt.Errorf("%w: invalid Collection ID or expected version", ErrInvalidArgument)
	}
	var result PendingChange
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		row, err := loadPendingForCollection(ctx, tx, collectionID)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: Collection has no Pending Change", ErrNotFound)
		}
		if err != nil {
			return err
		}
		if row.change.Version != expectedVersion {
			return fmt.Errorf("%w: Pending Change is at version %d, not %d", ErrConflict, row.change.Version, expectedVersion)
		}
		if err := ensureNoInProgressAttempt(ctx, tx, row.change.ChangeSetID); err != nil {
			return err
		}
		row.change.Status = ChangeDiscarded
		row.change.Version++
		row.change.Recovery = nil
		row.change.UpdatedAt = time.Now().UTC()
		if err := persistPending(ctx, tx, &row, false); err != nil {
			return err
		}
		result = row.change
		return nil
	})
	if err != nil {
		return PendingChange{}, err
	}
	return result, nil
}

func (service *Service) GetChange(ctx context.Context, changeSetID string) (ChangeDetail, error) {
	if !validOpaqueID(changeSetID, "chg_") {
		return ChangeDetail{}, fmt.Errorf("%w: invalid ChangeSet ID", ErrInvalidArgument)
	}
	var detail ChangeDetail
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		row, err := loadPendingByID(ctx, snapshot, changeSetID)
		if err != nil {
			return err
		}
		detail = ChangeDetail{ChangeSetID: row.change.ChangeSetID, CollectionID: row.change.CollectionID, Status: row.change.Status, Version: row.change.Version, Operations: row.change.Operations, ApplyAttempts: make([]ApplyAttempt, 0)}
		detail.RecoveryState = row.change.Recovery
		attempts, err := loadAttempts(ctx, snapshot, changeSetID)
		if err != nil {
			return err
		}
		detail.ApplyAttempts = attempts
		migration, err := loadMigrationByChange(ctx, snapshot, changeSetID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil {
			detail.AppliedMigration = &migration
		}
		if detail.RecoveryState == nil && len(attempts) > 0 {
			detail.RecoveryState = attempts[0].Recovery
		}
		return nil
	})
	return detail, err
}

func (service *Service) History(ctx context.Context, collectionID string, options ListOptions) (Page[AppliedMigration], error) {
	if !validOpaqueID(collectionID, "col_") {
		return Page[AppliedMigration]{}, fmt.Errorf("%w: invalid Collection ID", ErrInvalidArgument)
	}
	limit, err := pageLimit(options.Limit)
	if err != nil {
		return Page[AppliedMigration]{}, err
	}
	afterTime, afterID := "", ""
	if options.Cursor != "" {
		afterTime, afterID, err = decodeCursor(options.Cursor)
		if err != nil {
			return Page[AppliedMigration]{}, err
		}
	}
	page := Page[AppliedMigration]{Data: make([]AppliedMigration, 0, limit)}
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		if _, err := loadCollection(ctx, snapshot, collectionID); err != nil {
			return err
		}
		query := `SELECT id, change_set_id, collection_id, apply_attempt_id, applied_at, schema_version, diff_json, model_json FROM modelry_backend_applied_migrations WHERE collection_id = ?`
		args := []any{collectionID}
		if afterID != "" {
			query += ` AND (applied_at < ? OR (applied_at = ? AND id < ?))`
			args = append(args, afterTime, afterTime, afterID)
		}
		query += ` ORDER BY applied_at DESC, id DESC LIMIT ?`
		args = append(args, limit+1)
		rows, err := snapshot.QueryContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("read Applied History: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			migration, err := scanMigration(rows)
			if err != nil {
				return err
			}
			page.Data = append(page.Data, migration)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("finish reading Applied History: %w", err)
		}
		if len(page.Data) > limit {
			last := page.Data[limit-1]
			page.NextCursor = encodeCursor(timestamp(last.AppliedAt), last.ID)
			page.Data = page.Data[:limit]
		}
		return nil
	})
	return page, err
}

type ChangeEntry struct {
	PendingChange    *PendingChange    `json:"pendingChange,omitempty"`
	AppliedMigration *AppliedMigration `json:"appliedMigration,omitempty"`
}

func (service *Service) ListChanges(ctx context.Context, options ListOptions) (Page[ChangeEntry], error) {
	limit, err := pageLimit(options.Limit)
	if err != nil {
		return Page[ChangeEntry]{}, err
	}
	afterTime, afterID := "", ""
	if options.Cursor != "" {
		afterTime, afterID, err = decodeCursor(options.Cursor)
		if err != nil {
			return Page[ChangeEntry]{}, err
		}
	}
	page := Page[ChangeEntry]{Data: make([]ChangeEntry, 0)}
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		ordered := make([]orderedChangeEntry, 0, limit+1)
		pendingQuery := `SELECT id, collection_id, version, status, operations_json, recovery_json, created_at, updated_at FROM modelry_backend_changes WHERE status IN ('ready', 'needsReview', 'failed')`
		pendingArgs := make([]any, 0, 4)
		if afterID != "" {
			pendingQuery += ` AND (updated_at < ? OR (updated_at = ? AND id < ?))`
			pendingArgs = append(pendingArgs, afterTime, afterTime, afterID)
		}
		pendingQuery += ` ORDER BY updated_at DESC, id DESC LIMIT ?`
		pendingArgs = append(pendingArgs, limit+1)
		rows, err := snapshot.QueryContext(ctx, pendingQuery, pendingArgs...)
		if err != nil {
			return fmt.Errorf("list Pending Changes: %w", err)
		}
		for rows.Next() {
			var row pendingRow
			var status, createdAt, updatedAt string
			if err := rows.Scan(&row.change.ChangeSetID, &row.change.CollectionID, &row.change.Version, &status, &row.operationsJSON, &row.recoveryJSON, &createdAt, &updatedAt); err != nil {
				rows.Close()
				return fmt.Errorf("read Pending Change summary: %w", err)
			}
			row.change.Status = ChangeStatus(status)
			row.change.CreatedAt, _ = parseTimestamp(createdAt)
			row.change.UpdatedAt, _ = parseTimestamp(updatedAt)
			if err := json.Unmarshal([]byte(row.operationsJSON), &row.change.Operations); err != nil {
				rows.Close()
				return fmt.Errorf("decode Pending Change summary: %w", err)
			}
			if row.change.Operations == nil {
				row.change.Operations = make([]PendingOperation, 0)
			}
			if row.recoveryJSON.Valid {
				var recovery RecoveryState
				if err := json.Unmarshal([]byte(row.recoveryJSON.String), &recovery); err != nil {
					rows.Close()
					return fmt.Errorf("decode Pending Change recovery: %w", err)
				}
				row.change.Recovery = &recovery
			}
			ordered = append(ordered, orderedChangeEntry{time: row.change.UpdatedAt, id: row.change.ChangeSetID, entry: ChangeEntry{PendingChange: &row.change}})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("finish listing Pending Changes: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close Pending Changes: %w", err)
		}
		migrationQuery := `SELECT id, change_set_id, collection_id, apply_attempt_id, applied_at, schema_version, diff_json, model_json FROM modelry_backend_applied_migrations`
		migrationArgs := make([]any, 0, 4)
		if afterID != "" {
			migrationQuery += ` WHERE applied_at < ? OR (applied_at = ? AND id < ?)`
			migrationArgs = append(migrationArgs, afterTime, afterTime, afterID)
		}
		migrationQuery += ` ORDER BY applied_at DESC, id DESC LIMIT ?`
		migrationArgs = append(migrationArgs, limit+1)
		migrations, err := snapshot.QueryContext(ctx, migrationQuery, migrationArgs...)
		if err != nil {
			return fmt.Errorf("list Applied History: %w", err)
		}
		for migrations.Next() {
			migration, err := scanMigration(migrations)
			if err != nil {
				migrations.Close()
				return err
			}
			ordered = append(ordered, orderedChangeEntry{time: migration.AppliedAt, id: migration.ID, entry: ChangeEntry{AppliedMigration: &migration}})
		}
		if err := migrations.Err(); err != nil {
			migrations.Close()
			return fmt.Errorf("finish listing Applied History: %w", err)
		}
		if err := migrations.Close(); err != nil {
			return err
		}
		sort.Slice(ordered, func(i, j int) bool {
			if ordered[i].time.Equal(ordered[j].time) {
				return ordered[i].id > ordered[j].id
			}
			return ordered[i].time.After(ordered[j].time)
		})
		if len(ordered) > limit {
			last := ordered[limit-1]
			page.NextCursor = encodeCursor(timestamp(last.time), last.id)
			ordered = ordered[:limit]
		}
		for _, item := range ordered {
			page.Data = append(page.Data, item.entry)
		}
		return nil
	})
	return page, err
}

type orderedChangeEntry struct {
	time  time.Time
	id    string
	entry ChangeEntry
}

func (service *Service) RecoverInterruptedApplies(ctx context.Context) error {
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		return service.recoverInterrupted(ctx, tx)
	})
}

func loadPendingByID(ctx context.Context, query storage.Executor, changeSetID string) (pendingRow, error) {
	var row pendingRow
	var status, createdAt, updatedAt string
	if err := query.QueryRowContext(ctx, `SELECT id, collection_id, version, status, operations_json, recovery_json, created_at, updated_at FROM modelry_backend_changes WHERE id = ?`, changeSetID).Scan(&row.change.ChangeSetID, &row.change.CollectionID, &row.change.Version, &status, &row.operationsJSON, &row.recoveryJSON, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return pendingRow{}, fmt.Errorf("%w: ChangeSet %q does not exist", ErrNotFound, changeSetID)
		}
		return pendingRow{}, fmt.Errorf("read ChangeSet: %w", err)
	}
	row.change.Status = ChangeStatus(status)
	row.change.CreatedAt, _ = parseTimestamp(createdAt)
	row.change.UpdatedAt, _ = parseTimestamp(updatedAt)
	if err := json.Unmarshal([]byte(row.operationsJSON), &row.change.Operations); err != nil {
		return pendingRow{}, fmt.Errorf("decode ChangeSet operations: %w", err)
	}
	if row.change.Operations == nil {
		row.change.Operations = make([]PendingOperation, 0)
	}
	if row.recoveryJSON.Valid {
		var recovery RecoveryState
		if err := json.Unmarshal([]byte(row.recoveryJSON.String), &recovery); err != nil {
			return pendingRow{}, fmt.Errorf("decode ChangeSet recovery state: %w", err)
		}
		row.change.Recovery = &recovery
	}
	return row, nil
}

func loadAttempts(ctx context.Context, query storage.Executor, changeSetID string) ([]ApplyAttempt, error) {
	rows, err := query.QueryContext(ctx, `SELECT id, change_set_id, status, started_at, finished_at, evaluation_json, error_code, recovery_json, applied_migration_id FROM modelry_backend_apply_attempts WHERE change_set_id = ? ORDER BY started_at DESC, id DESC`, changeSetID)
	if err != nil {
		return nil, fmt.Errorf("list Apply attempts: %w", err)
	}
	defer rows.Close()
	attempts := make([]ApplyAttempt, 0)
	for rows.Next() {
		var attempt ApplyAttempt
		var status, startedAt, evaluationJSON string
		var finishedAt, errorCode, recoveryJSON, migrationID sql.NullString
		if err := rows.Scan(&attempt.ID, &attempt.ChangeSetID, &status, &startedAt, &finishedAt, &evaluationJSON, &errorCode, &recoveryJSON, &migrationID); err != nil {
			return nil, fmt.Errorf("read Apply attempt: %w", err)
		}
		attempt.Status = AttemptStatus(status)
		attempt.StartedAt, _ = parseTimestamp(startedAt)
		if finishedAt.Valid {
			parsed, err := parseTimestamp(finishedAt.String)
			if err != nil {
				return nil, err
			}
			attempt.FinishedAt = &parsed
		}
		if err := json.Unmarshal([]byte(evaluationJSON), &attempt.Evaluation); err != nil {
			return nil, fmt.Errorf("decode Apply attempt evaluation: %w", err)
		}
		if errorCode.Valid {
			attempt.ErrorCode = errorCode.String
		}
		if recoveryJSON.Valid {
			var recovery RecoveryState
			if err := json.Unmarshal([]byte(recoveryJSON.String), &recovery); err != nil {
				return nil, fmt.Errorf("decode Apply attempt recovery: %w", err)
			}
			attempt.Recovery = &recovery
		}
		if migrationID.Valid {
			attempt.AppliedMigrationID = migrationID.String
		}
		attempts = append(attempts, attempt)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("finish listing Apply attempts: %w", err)
	}
	return attempts, nil
}

func loadMigrationByChange(ctx context.Context, query storage.Executor, changeSetID string) (AppliedMigration, error) {
	row := query.QueryRowContext(ctx, `SELECT id, change_set_id, collection_id, apply_attempt_id, applied_at, schema_version, diff_json, model_json FROM modelry_backend_applied_migrations WHERE change_set_id = ? ORDER BY applied_at DESC LIMIT 1`, changeSetID)
	var migration AppliedMigration
	var appliedAt, diffJSON, modelJSON string
	if err := row.Scan(&migration.ID, &migration.ChangeSetID, &migration.CollectionID, &migration.ApplyAttemptID, &appliedAt, &migration.SchemaVersion, &diffJSON, &modelJSON); err != nil {
		return AppliedMigration{}, err
	}
	var err error
	migration.AppliedAt, err = parseTimestamp(appliedAt)
	if err != nil {
		return AppliedMigration{}, err
	}
	if err := json.Unmarshal([]byte(diffJSON), &migration.Diff); err != nil {
		return AppliedMigration{}, fmt.Errorf("decode Applied History diff: %w", err)
	}
	if err := json.Unmarshal([]byte(modelJSON), &migration.Model); err != nil {
		return AppliedMigration{}, fmt.Errorf("decode Applied History model: %w", err)
	}
	return migration, nil
}

func scanMigration(rows *sql.Rows) (AppliedMigration, error) {
	var migration AppliedMigration
	var appliedAt, diffJSON, modelJSON string
	if err := rows.Scan(&migration.ID, &migration.ChangeSetID, &migration.CollectionID, &migration.ApplyAttemptID, &appliedAt, &migration.SchemaVersion, &diffJSON, &modelJSON); err != nil {
		return AppliedMigration{}, fmt.Errorf("scan Applied History: %w", err)
	}
	parsed, err := parseTimestamp(appliedAt)
	if err != nil {
		return AppliedMigration{}, err
	}
	migration.AppliedAt = parsed
	if err := json.Unmarshal([]byte(diffJSON), &migration.Diff); err != nil {
		return AppliedMigration{}, fmt.Errorf("decode Applied History diff: %w", err)
	}
	if err := json.Unmarshal([]byte(modelJSON), &migration.Model); err != nil {
		return AppliedMigration{}, fmt.Errorf("decode Applied History model: %w", err)
	}
	return migration, nil
}

func mustJSON(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
