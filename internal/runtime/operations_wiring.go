package runtime

import (
	"context"
	"errors"

	"github.com/liujingwen1225/modelry/internal/activity"
	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// driftAuditSink 把投影修复写入共享 Audit 存储。
type driftAuditSink struct{ audits *audit.Service }

func (sink driftAuditSink) AppendDriftFactInTransaction(ctx context.Context, tx storage.Executor, action, resourceID, result string) error {
	if sink.audits == nil {
		return nil
	}
	actor, ok := audit.ActorFromContext(ctx)
	if !ok {
		return nil
	}
	return sink.audits.AppendInTransaction(ctx, tx, audit.AppendInput{
		Actor: actor, Action: action, Resource: audit.Resource{Kind: "runtime", ID: resourceID}, Result: result,
	})
}

// settingsAuditSink 把 Runtime Settings 变更写入共享 Audit 存储。
type settingsAuditSink struct{ audits *audit.Service }

func (sink settingsAuditSink) AppendSettingsFactInTransaction(ctx context.Context, tx storage.Executor, action, resourceID, result string) error {
	if sink.audits == nil {
		return nil
	}
	actor, ok := audit.ActorFromContext(ctx)
	if !ok {
		return nil
	}
	return sink.audits.AppendInTransaction(ctx, tx, audit.AppendInput{
		Actor: actor, Action: action, Resource: audit.Resource{Kind: "runtime", ID: resourceID}, Result: result,
	})
}

// simulationRecordLookup 让 Policy Simulation 读取一个已提交 Record，而不引入第二套记录语义。
type simulationRecordLookup struct{ records *records.Service }

func (lookup simulationRecordLookup) SimulationRecord(ctx context.Context, collectionID, recordID string) (*authorization.Record, error) {
	if lookup.records == nil {
		return nil, nil
	}
	record, err := lookup.records.Get(ctx, collectionID, recordID)
	if err != nil {
		if errors.Is(err, records.ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &authorization.Record{ID: record.ID, Values: record.Values}, nil
}

// activityFactsFunc 让各子系统保持自己的 ActivityFacts 命名，同时实现 Activity 的 Source 端口。
type activityFactsFunc func(ctx context.Context, query storage.Executor, limit int) ([]activity.Fact, error)

func (function activityFactsFunc) Facts(ctx context.Context, query storage.Executor, limit int) ([]activity.Fact, error) {
	return function(ctx, query, limit)
}

// defaultListenAddress 返回既没有显式 flag 也没有 Project 取值时使用的内建监听地址。
func defaultListenAddress(options Options) string {
	if options.ListenDefault != "" {
		return options.ListenDefault
	}
	return "127.0.0.1:8080"
}