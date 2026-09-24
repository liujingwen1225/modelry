package backendmodel

import (
	"context"
	"fmt"
	"strings"

	"github.com/liujingwen1225/modelry/internal/storage"
)

// CollectionSummary 为 Collections 清单提供必要的轻量元数据，不加载 Record 内容或 Pending Operation。
type CollectionSummary struct {
	Collection
	RecordCount         int64        `json:"recordCount"`
	PendingChangeStatus ChangeStatus `json:"pendingChangeStatus,omitempty"`
}

// CollectionSummaryOptions 指定本次 Collection 摘要需要计算的可选信息。
type CollectionSummaryOptions struct {
	IncludeRecordCount         bool
	IncludePendingChangeStatus bool
}

// ListCollectionSummaries 返回当前页 Collection，以及调用方请求的可选摘要信息。
// Record 数量通过 storage 聚合查询，不会物化 Record 行。
func (service *Service) ListCollectionSummaries(ctx context.Context, options ListOptions, summaryOptions CollectionSummaryOptions) (Page[CollectionSummary], error) {
	limit, err := pageLimit(options.Limit)
	if err != nil {
		return Page[CollectionSummary]{}, err
	}
	var afterTime, afterID string
	if options.Cursor != "" {
		afterTime, afterID, err = decodeCursor(options.Cursor)
		if err != nil {
			return Page[CollectionSummary]{}, err
		}
	}
	page := Page[CollectionSummary]{Data: make([]CollectionSummary, 0, limit)}
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		query := `SELECT id, name, type, model_json, created_at, updated_at FROM modelry_backend_collections`
		args := []any{}
		if afterID != "" {
			query += ` WHERE created_at > ? OR (created_at = ? AND id > ?)`
			args = append(args, afterTime, afterTime, afterID)
		}
		query += ` ORDER BY created_at, id LIMIT ?`
		args = append(args, limit+1)
		rows, err := snapshot.QueryContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("list Collection summaries: %w", err)
		}
		collections := make([]Collection, 0, limit+1)
		for rows.Next() {
			collection, err := scanCollection(rows)
			if err != nil {
				rows.Close()
				return err
			}
			collections = append(collections, collection)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return fmt.Errorf("finish listing Collection summaries: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close Collection summaries: %w", err)
		}
		if len(collections) > limit {
			last := collections[limit-1]
			page.NextCursor = encodeCursor(timestamp(last.CreatedAt), last.ID)
			collections = collections[:limit]
		}
		if len(collections) == 0 {
			return nil
		}

		statuses := map[string]ChangeStatus{}
		if summaryOptions.IncludePendingChangeStatus {
			statuses, err = activeChangeStatuses(ctx, snapshot, collections)
			if err != nil {
				return err
			}
		}
		for _, collection := range collections {
			var recordCount int64
			if summaryOptions.IncludeRecordCount {
				recordCount, err = storage.CountCollectionRecords(ctx, snapshot, collection.ID)
				if err != nil {
					return err
				}
			}
			page.Data = append(page.Data, CollectionSummary{
				Collection:          collection,
				RecordCount:         recordCount,
				PendingChangeStatus: statuses[collection.ID],
			})
		}
		return nil
	})
	return page, err
}

func activeChangeStatuses(ctx context.Context, query storage.Executor, collections []Collection) (map[string]ChangeStatus, error) {
	if len(collections) == 0 {
		return map[string]ChangeStatus{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(collections)), ",")
	statement := `SELECT collection_id, status FROM modelry_backend_changes WHERE status IN ('ready', 'needsReview', 'failed') AND collection_id IN (` + placeholders + `)`
	args := make([]any, 0, len(collections))
	for _, collection := range collections {
		args = append(args, collection.ID)
	}
	rows, err := query.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, fmt.Errorf("read active Collection Change statuses: %w", err)
	}
	defer rows.Close()
	statuses := make(map[string]ChangeStatus, len(collections))
	for rows.Next() {
		var collectionID, status string
		if err := rows.Scan(&collectionID, &status); err != nil {
			return nil, fmt.Errorf("scan active Collection Change status: %w", err)
		}
		statuses[collectionID] = ChangeStatus(status)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("finish reading active Collection Change statuses: %w", err)
	}
	return statuses, nil
}
