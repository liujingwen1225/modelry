package runtime

import (
	"context"

	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// adminAuthAuditSink 把 Control Plane 安全事实写入共享 Audit 存储。
type adminAuthAuditSink struct{ audits *audit.Service }

func (sink adminAuthAuditSink) AppendControlPlaneFact(ctx context.Context, fact adminauth.ControlPlaneFact) error {
	if sink.audits == nil {
		return nil
	}
	return sink.audits.Append(ctx, adminAuthAuditInput(fact))
}

func (sink adminAuthAuditSink) AppendControlPlaneFactInTransaction(ctx context.Context, tx storage.Executor, fact adminauth.ControlPlaneFact) error {
	if sink.audits == nil {
		return nil
	}
	return sink.audits.AppendInTransaction(ctx, tx, adminAuthAuditInput(fact))
}

func adminAuthAuditInput(fact adminauth.ControlPlaneFact) audit.AppendInput {
	return audit.AppendInput{
		Actor:    audit.Actor{Kind: audit.ActorKind(fact.ActorKind), ID: fact.ActorID},
		Action:   fact.Action,
		Resource: audit.Resource{Kind: fact.ResourceKind, ID: fact.ResourceID},
		Result:   fact.Result,
	}
}
