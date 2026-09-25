package portability

import (
	"context"
	"sort"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// SnapshotReader 从一个已经落盘的 SQLite 快照读取 Backup 需要的全部项目事实。
// 数据库载荷、引用对象集合、counts 与 Applied Model hash 必须全部来自同一个
// SnapshotReader，Backup 才能在 Runtime 继续服务时保持自洽。
type SnapshotReader interface {
	// ProjectID 返回快照中的耐久项目标识。
	ProjectID() string
	// AppliedCollections 返回快照中的 Applied Collections（按 Name 稳定排序）。
	AppliedCollections(ctx context.Context) ([]backendmodel.Collection, error)
	// ReferencedFileKeys 返回快照中 Durable Record 真正引用的对象 key（去重并排序）。
	ReferencedFileKeys(ctx context.Context) ([]string, error)
	// Counts 返回快照中的 Collection 与 Record 计数。
	Counts(ctx context.Context) (Counts, error)
	// Close 释放快照读取器；它不改变快照文件。
	Close() error
}

// SnapshotSource 为一个已经落盘的 SQLite 快照打开只读读取器。
type SnapshotSource interface {
	OpenSnapshot(ctx context.Context, databasePath string) (SnapshotReader, error)
}

// liveSnapshotSource 是默认实现。它复用 Runtime 自己的读取路径（Backend Model
// 与 Records Service），只是把持久化换成只读快照，因此 Backup 读到的语义与
// Application API 完全一致，不会因为另写一套 SQL 而漂移。
type liveSnapshotSource struct{}

func (liveSnapshotSource) OpenSnapshot(_ context.Context, databasePath string) (SnapshotReader, error) {
	store, err := storage.OpenReadOnly(databasePath)
	if err != nil {
		return nil, err
	}
	models, err := backendmodel.NewReadOnlyService(store)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	recordService, err := records.New(store, models)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	return &snapshotReader{store: store, models: models, records: recordService}, nil
}

type snapshotReader struct {
	store   *storage.Store
	models  *backendmodel.Service
	records *records.Service
}

func (reader *snapshotReader) ProjectID() string { return reader.store.ProjectID() }

func (reader *snapshotReader) AppliedCollections(ctx context.Context) ([]backendmodel.Collection, error) {
	return collectCollections(ctx, reader.models)
}

func (reader *snapshotReader) ReferencedFileKeys(ctx context.Context) ([]string, error) {
	return reader.records.ReferencedFileKeys(ctx)
}

func (reader *snapshotReader) Counts(ctx context.Context) (Counts, error) {
	collections, err := reader.store.CollectionCount(ctx)
	if err != nil {
		return Counts{}, err
	}
	recordCount, err := reader.store.ProjectedRecordCount(ctx)
	if err != nil {
		return Counts{}, err
	}
	return Counts{Collections: collections, Records: recordCount}, nil
}

func (reader *snapshotReader) Close() error { return reader.store.Close() }

// collectionLister 是 live Applied Model 与快照读取器共用的最小读取面。
type collectionLister interface {
	ListCollections(ctx context.Context, options backendmodel.ListOptions) (backendmodel.Page[backendmodel.Collection], error)
}

// collectCollections 分页读取 Applied Collections 并按 Name 稳定排序。
//
// 它必须读到完整的 Applied Model：appliedModelHash 建立在这份列表上，静默丢弃一部分
// Collection 会让 hash 描述一个不完整的模型，从而让 import 的 model compatibility gate
// 失效。Contract 的 Collection 上限属于 Contract 生成，不在这里施加——它由 BuildContract
// 明确拒绝，绝不截断。
func collectCollections(ctx context.Context, source collectionLister) ([]backendmodel.Collection, error) {
	collections := make([]backendmodel.Collection, 0, 16)
	cursor := ""
	for {
		page, err := source.ListCollections(ctx, backendmodel.ListOptions{Limit: 100, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		collections = append(collections, page.Data...)
		if page.NextCursor == "" || len(page.Data) == 0 {
			break
		}
		cursor = page.NextCursor
	}
	sort.SliceStable(collections, func(left, right int) bool { return collections[left].Name < collections[right].Name })
	return collections, nil
}
