package backendapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// 集合删除实现 docs/specs/0012-collection-deletion.md。
//
// 一个 Collection 横跨多张领域表与一张动态投影表，并且 foreign_keys(1) 已开启。
// 全部清理在单个事务内按依赖顺序执行；外部文件对象在事务提交之后尽力清理。
// 该操作不可逆，只允许 Owner 会话调用；控制面权限映射刻意不登记此路由，
// 让 Administrator 与 Service Account 走 fail closed 的 403。

var (
	collectionIDPattern = regexp.MustCompile(`^col_[A-Za-z0-9_-]{8,64}$`)
	fileObjectPattern   = regexp.MustCompile(`obj_[0-9a-f]{32}`)
)

var (
	errDeletionApplying        = errors.New("a schema change is currently being applied")
	errDeletionConfirmMismatch = errors.New("the collection name confirmation did not match")
)

type deletionTransactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
}

type deletionAuditSink interface {
	AppendInTransaction(context.Context, storage.Executor, audit.AppendInput) error
}

// DeletionFileCleaner 在事务提交后清理不再被引用的文件对象。
// 返回成功删除的数量；清理失败不改变集合删除结果。
type DeletionFileCleaner interface {
	DeleteUnreferenced(context.Context, []string) (int, error)
}

type CollectionDeletionResult struct {
	CollectionID       string `json:"collectionId"`
	Name               string `json:"name"`
	DeletedRecords     int64  `json:"deletedRecords"`
	DiscardedChanges   int64  `json:"discardedChanges"`
	RevokedSessions    int64  `json:"revokedSessions"`
	DeletedFileObjects int    `json:"deletedFileObjects"`
	PendingFileObjects int    `json:"pendingFileObjects,omitempty"`
	Irreversible       bool   `json:"irreversible"`
}

type DeletionModule struct {
	store  deletionTransactionalStore
	audits deletionAuditSink
	files  DeletionFileCleaner
}

func NewDeletionModule(store deletionTransactionalStore, audits deletionAuditSink, files DeletionFileCleaner) *DeletionModule {
	return &DeletionModule{store: store, audits: audits, files: files}
}

func (module *DeletionModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("DELETE /admin/api/v1/collections/{collectionId}", module.deleteCollection)
}

func (module *DeletionModule) deleteCollection(w http.ResponseWriter, request *http.Request) {
	if module == nil || module.store == nil {
		httpapi.WriteAPIError(w, request, http.StatusServiceUnavailable, httpapi.APIError{
			Code: "RUNTIME_NOT_READY", Message: "Collection deletion is not ready. Retry after the Runtime is ready.",
		})
		return
	}
	// 删除是不可逆的 Owner-only 操作；不依赖路由映射的隐式 fail closed。
	if _, owner := adminauth.OwnerFromContext(request.Context()); !owner {
		httpapi.WriteAPIError(w, request, http.StatusForbidden, httpapi.APIError{
			Code: "FORBIDDEN", Message: "Only the Owner can permanently delete a Collection.",
			Hint: "Ask the Owner to delete this Collection.",
		})
		return
	}
	collectionID := strings.TrimSpace(request.PathValue("collectionId"))
	if !collectionIDPattern.MatchString(collectionID) {
		writeDeletionProblem(w, request, backendmodel.ErrNotFound)
		return
	}
	// 前端要求输入集合名称确认；后端在提供 confirmName 时同样校验，避免绕过界面。
	var confirmation struct {
		ConfirmName string `json:"confirmName"`
	}
	if request.ContentLength != 0 {
		decoder := json.NewDecoder(http.MaxBytesReader(w, request.Body, maxRequestBody))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&confirmation); err != nil {
			writeDeletionProblem(w, request, requestProblem{status: http.StatusBadRequest, code: "INVALID_ARGUMENT", message: "The confirmation body is invalid."})
			return
		}
	}

	result, fileKeys, err := module.remove(request.Context(), collectionID, confirmation.ConfirmName)
	if err != nil {
		writeDeletionProblem(w, request, err)
		return
	}

	// 外部副作用不参与数据库事务：提交后尽力清理，失败只回报待处理数量。
	if module.files != nil && len(fileKeys) > 0 {
		deleted, cleanupErr := module.files.DeleteUnreferenced(request.Context(), fileKeys)
		result.DeletedFileObjects = deleted
		if cleanupErr != nil || deleted < len(fileKeys) {
			result.PendingFileObjects = len(fileKeys) - deleted
		}
	} else if len(fileKeys) > 0 {
		result.PendingFileObjects = len(fileKeys)
	}

	httpapi.WriteAPIJSON(w, http.StatusOK, dataResponse[CollectionDeletionResult]{Data: result})
}

// remove 在单个事务内收集影响范围、按依赖顺序清理并写入审计事实。
func (module *DeletionModule) remove(ctx context.Context, collectionID, confirmName string) (CollectionDeletionResult, []string, error) {
	var result CollectionDeletionResult
	var fileKeys []string
	err := module.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var name string
		err := tx.QueryRowContext(ctx, `SELECT name FROM modelry_backend_collections WHERE id = ?`, collectionID).Scan(&name)
		if errors.Is(err, sql.ErrNoRows) {
			return backendmodel.ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("read Collection before deletion: %w", err)
		}
		if confirmName != "" && !strings.EqualFold(strings.TrimSpace(confirmName), name) {
			return errDeletionConfirmMismatch
		}

		var applying int64
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM modelry_backend_changes WHERE collection_id = ? AND status = 'applying'`, collectionID,
		).Scan(&applying); err != nil {
			return fmt.Errorf("check in-progress schema changes: %w", err)
		}
		if applying > 0 {
			return errDeletionApplying
		}

		count := func(query string) (int64, error) {
			var value int64
			if err := tx.QueryRowContext(ctx, query, collectionID).Scan(&value); err != nil {
				return 0, fmt.Errorf("count deletion impact: %w", err)
			}
			return value, nil
		}
		result.DeletedRecords, err = countCollectionRecords(ctx, tx, collectionID)
		if err != nil {
			return err
		}
		result.RevokedSessions, err = count(`SELECT COUNT(*) FROM modelry_app_sessions WHERE collection_id = ? AND revoked_at IS NULL`)
		if err != nil {
			return err
		}
		result.DiscardedChanges, err = count(`SELECT COUNT(*) FROM modelry_backend_changes WHERE collection_id = ? AND status IN ('ready','needsReview')`)
		if err != nil {
			return err
		}
		fileKeys, err = readCollectionFileKeys(ctx, tx, collectionID)
		if err != nil {
			return err
		}

		// 顺序受 SQLite 外键约束支配：applied_migrations 引用 apply_attempts，
		// 因此必须先删 migrations，再删 attempts，最后删 changes。
		statements := []string{
			`DELETE FROM modelry_backend_applied_migrations WHERE collection_id = ?`,
			`DELETE FROM modelry_backend_apply_attempts WHERE change_set_id IN (SELECT id FROM modelry_backend_changes WHERE collection_id = ?)`,
			`DELETE FROM modelry_backend_changes WHERE collection_id = ?`,
			`DELETE FROM modelry_record_events WHERE collection_id = ?`,
			`DELETE FROM modelry_record_event_sequences WHERE collection_id = ?`,
			`DELETE FROM modelry_record_event_watermarks WHERE collection_id = ?`,
			`DELETE FROM modelry_access_rules WHERE collection_id = ?`,
			`DELETE FROM modelry_auth_configurations WHERE collection_id = ?`,
			`DELETE FROM modelry_app_password_credentials WHERE collection_id = ?`,
			`DELETE FROM modelry_app_sessions WHERE collection_id = ?`,
			`DELETE FROM modelry_app_recovery_tokens WHERE collection_id = ?`,
			`DELETE FROM modelry_extension_bindings WHERE collection_id = ?`,
		}
		for index, statement := range statements {
			if _, err := tx.ExecContext(ctx, statement, collectionID); err != nil {
				return fmt.Errorf("delete Collection dependent state (step %d): %w", index+1, err)
			}
		}

		table, err := storage.QuoteSQLiteIdentifier(storage.RecordTableName(collectionID))
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DROP TABLE IF EXISTS `+table); err != nil {
			return fmt.Errorf("drop Collection Records projection: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM modelry_backend_collections WHERE id = ?`, collectionID); err != nil {
			return fmt.Errorf("delete Collection: %w", err)
		}

		if module.audits != nil {
			actor, ok := audit.ActorFromContext(ctx)
			if !ok {
				actor = audit.Actor{Kind: audit.ActorOwner, ID: "owner"}
			}
			if err := module.audits.AppendInTransaction(ctx, tx, audit.AppendInput{
				Actor:    actor,
				Action:   "collection.deleted",
				Resource: audit.Resource{Kind: "collection", ID: collectionID},
				Result:   "success",
			}); err != nil {
				return fmt.Errorf("append Collection deletion Audit fact: %w", err)
			}
		}

		result.CollectionID = collectionID
		result.Name = name
		result.Irreversible = true
		return nil
	})
	return result, fileKeys, err
}

func countCollectionRecords(ctx context.Context, tx storage.Executor, collectionID string) (int64, error) {
	table := storage.RecordTableName(collectionID)
	var exists int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
	).Scan(&exists); err != nil {
		return 0, fmt.Errorf("check Collection Records projection: %w", err)
	}
	if exists == 0 {
		return 0, nil
	}
	return storage.CountCollectionRecords(ctx, tx, collectionID)
}

// readCollectionFileKeys 在 DROP TABLE 之前读出该集合引用过的文件对象键。
// 投影表列名由 Runtime 生成，因此按行扫描所有列并用不透明键格式提取。
func readCollectionFileKeys(ctx context.Context, tx storage.Executor, collectionID string) ([]string, error) {
	table, err := storage.QuoteSQLiteIdentifier(storage.RecordTableName(collectionID))
	if err != nil {
		return nil, err
	}
	var exists int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, storage.RecordTableName(collectionID),
	).Scan(&exists); err != nil {
		return nil, fmt.Errorf("check Collection Records projection: %w", err)
	}
	if exists == 0 {
		return nil, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT * FROM `+table)
	if err != nil {
		return nil, fmt.Errorf("read Collection File references: %w", err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("read Collection projection columns: %w", err)
	}
	found := make(map[string]struct{})
	for rows.Next() {
		values := make([]any, len(columns))
		destinations := make([]any, len(columns))
		for index := range values {
			destinations[index] = &values[index]
		}
		if err := rows.Scan(destinations...); err != nil {
			return nil, fmt.Errorf("scan Collection projection row: %w", err)
		}
		for _, value := range values {
			var text string
			switch typed := value.(type) {
			case string:
				text = typed
			case []byte:
				text = string(typed)
			default:
				continue
			}
			for _, key := range fileObjectPattern.FindAllString(text, -1) {
				found[key] = struct{}{}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Collection projection rows: %w", err)
	}
	keys := make([]string, 0, len(found))
	for key := range found {
		keys = append(keys, key)
	}
	return keys, nil
}

func writeDeletionProblem(w http.ResponseWriter, request *http.Request, err error) {
	status := http.StatusInternalServerError
	problem := httpapi.APIError{Code: "INTERNAL_ERROR", Message: "The Runtime could not delete this Collection."}
	var input requestProblem
	switch {
	case errors.As(err, &input):
		status = input.status
		problem.Code = input.code
		problem.Message = input.message
	case errors.Is(err, backendmodel.ErrNotFound):
		status = http.StatusNotFound
		problem.Code = "NOT_FOUND"
		problem.Message = "The requested Collection was not found."
	case errors.Is(err, errDeletionApplying):
		status = http.StatusConflict
		problem.Code = "CONFLICT"
		problem.Message = "A schema change is currently being applied to this Collection. Try again shortly."
		problem.Hint = "Wait for the apply to finish, then delete the Collection again."
	case errors.Is(err, errDeletionConfirmMismatch):
		status = http.StatusBadRequest
		problem.Code = "INVALID_ARGUMENT"
		problem.Message = "The Collection name confirmation did not match."
	case errors.Is(err, backendmodel.ErrInvalidArgument), errors.Is(err, errDeletionConfirmMismatch):
		status = http.StatusBadRequest
		problem.Code = "INVALID_ARGUMENT"
		problem.Message = "The deletion request is invalid."
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*DeletionModule)(nil)
