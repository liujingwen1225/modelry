package runtime

import (
	"context"

	"github.com/liujingwen1225/modelry/internal/appauth"
	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/mail"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// mailAuditSink 把 Mail Control Plane 事实写入共享 Audit 存储。
type mailAuditSink struct{ audits *audit.Service }

func (sink mailAuditSink) AppendMailFact(ctx context.Context, action, resourceID, result string) error {
	if sink.audits == nil {
		return nil
	}
	actor, ok := audit.ActorFromContext(ctx)
	if !ok {
		return nil
	}
	return sink.audits.Append(ctx, mailAuditInput(actor, action, resourceID, result))
}

func (sink mailAuditSink) AppendMailFactInTransaction(ctx context.Context, tx storage.Executor, action, resourceID, result string) error {
	if sink.audits == nil {
		return nil
	}
	actor, ok := audit.ActorFromContext(ctx)
	if !ok {
		return nil
	}
	return sink.audits.AppendInTransaction(ctx, tx, mailAuditInput(actor, action, resourceID, result))
}

func mailAuditInput(actor audit.Actor, action, resourceID, result string) audit.AppendInput {
	return audit.AppendInput{Actor: actor, Action: action, Resource: audit.Resource{Kind: "mail", ID: resourceID}, Result: result}
}

// authAuditSink 记录 App User 的恢复流程事实。
type authAuditSink struct{ audits *audit.Service }

func (sink authAuditSink) AppendAuthFactInTransaction(_ context.Context, tx storage.Executor, actorKind, actorID, action, resourceKind, resourceID string) error {
	if sink.audits == nil {
		return nil
	}
	actor := audit.Actor{Kind: audit.ActorKind(actorKind), ID: actorID}
	placeholder := context.Background()
	return sink.audits.AppendInTransaction(placeholder, tx, audit.AppendInput{Actor: actor, Action: action, Resource: audit.Resource{Kind: resourceKind, ID: resourceID}, Result: "success"})
}

// mailPayloadAdapter 让 Mail outbox 复用 App Auth 的投递正文渲染。
type mailPayloadAdapter struct{ service *appauth.Service }

func (adapter mailPayloadAdapter) RenderDeliveryPayload(ctx context.Context, kind mail.DeliveryKind, payloadRef, recipient string) (string, string, error) {
	return adapter.service.RenderDeliveryPayload(ctx, string(kind), payloadRef, recipient)
}

// mailEnqueuerAdapter 让 App Auth 在自身事务内写入 Mail Delivery 意图。
type mailEnqueuerAdapter struct{ service *mail.Service }

func (adapter mailEnqueuerAdapter) EnqueueRecoveryMail(ctx context.Context, tx storage.Executor, kind string, recipient, payloadRef string) error {
	_, err := adapter.service.Enqueue(ctx, tx, mail.DeliveryKind(kind), recipient, payloadRef)
	return err
}

func (adapter mailEnqueuerAdapter) MailConfigured(ctx context.Context) (bool, error) {
	config, err := adapter.service.GetConfig(ctx)
	if err != nil {
		return false, err
	}
	return config.Configured(), nil
}
