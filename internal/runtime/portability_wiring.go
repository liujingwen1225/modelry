package runtime

import (
	"context"
	"io"

	"github.com/liujingwen1225/modelry/internal/accesscontrol"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/filestore"
	"github.com/liujingwen1225/modelry/internal/portability"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// portabilityObjects 让 Backup 按键读取当前 Provider 中的文件对象字节。
// 被引用的 key 集合来自 SQLite 快照，因此这里只负责读字节。
type portabilityObjects struct {
	files *filestore.Service
}

func (source portabilityObjects) OpenObject(ctx context.Context, key string) (io.ReadCloser, error) {
	provider, err := source.files.ActiveProvider(ctx)
	if err != nil {
		return nil, err
	}
	reader, _, err := provider.Open(ctx, key)
	return reader, err
}

// portabilityAuditSink 把 backup 与 restore preflight 写入共享 Audit 存储。
type portabilityAuditSink struct{ audits *audit.Service }

func (sink portabilityAuditSink) AppendPortabilityFact(ctx context.Context, action, resourceID, result string) error {
	if sink.audits == nil {
		return nil
	}
	actor, ok := audit.ActorFromContext(ctx)
	if !ok {
		return nil
	}
	return sink.audits.Append(ctx, audit.AppendInput{
		Actor: actor, Action: action, Resource: audit.Resource{Kind: "portability", ID: safeResourceID(resourceID)}, Result: result,
	})
}

func safeResourceID(value string) string {
	if value == "" {
		return "runtime"
	}
	trimmed := value
	if len(trimmed) > 128 {
		trimmed = trimmed[:128]
	}
	return trimmed
}

// portabilityRules 提供 Typed Application API Contract 需要的 Applied Access Rule 摘要。
type portabilityRules struct{ rules *accesscontrol.Service }

func (adapter portabilityRules) AppliedRuleSummary(ctx context.Context, collectionID string) ([]portability.ContractAccessRule, error) {
	if adapter.rules == nil {
		return nil, nil
	}
	state, err := adapter.rules.Get(ctx, collectionID)
	if err != nil {
		return nil, err
	}
	summary := make([]portability.ContractAccessRule, 0, len(state.Applied))
	for _, rule := range state.Applied {
		summary = append(summary, portability.ContractAccessRule{Operation: string(rule.Operation), Mode: string(rule.Mode)})
	}
	return summary, nil
}

// portabilityRecordSource 复用 Records Service：Import 因此与 Application API 共享同一套语义。
type portabilityRecordSource struct{ records *records.Service }

func (source portabilityRecordSource) List(ctx context.Context, collectionID string, options records.ListOptions) (records.Page, error) {
	return source.records.List(ctx, collectionID, options)
}

func (source portabilityRecordSource) Create(ctx context.Context, collectionID string, values map[string]any) (records.Record, error) {
	return source.records.Create(ctx, collectionID, values)
}

// newPortabilityService 组装 Backup/Restore/Export/Import/Contract 编排。
func newPortabilityService(options portabilityOptions) (*portability.Service, *portability.Module, error) {
	objects := portabilityObjects{files: options.files}
	service, err := portability.NewService(portability.Options{
		Store: options.store, Objects: objects, Models: options.models,
		ManagedDir: options.managedDir, Version: options.version,
	})
	if err != nil {
		return nil, nil, err
	}
	module := portability.NewModule(portability.ModuleOptions{
		Service: service,
		Records: portabilityRecordSource{records: options.records},
		Resolver: options.models,
		Rules: portabilityRules{rules: options.accessRules},
		Audits: portabilityAuditSink{audits: options.audits},
	})
	return service, module, nil
}

// portabilityOptions 是 Runtime 组装 Portability 需要的依赖。
type portabilityOptions struct {
	store       *storage.Store
	models      *backendmodel.Service
	records     *records.Service
	files       *filestore.Service
	accessRules *accesscontrol.Service
	audits      *audit.Service
	managedDir  string
	version     string
}
