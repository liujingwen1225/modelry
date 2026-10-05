package agent

import (
	"context"
	"fmt"
	"github.com/liujingwen1225/modelry/internal/storage"
	"strings"
)

func targetKey(op Operation) string {
	group := strings.Split(op.Name, "_")[0]
	for _, id := range []string{"collectionId", "recordId", "extensionId", "webhookId", "eventHookId", "jobId", "deliveryId"} {
		if v, ok := op.Arguments[id].(string); ok {
			group += "/" + id + "/" + v
		}
	}
	return group
}

// 批准固定清单；执行逐项验证，并显示部分完成，不承诺跨 API 事务回滚。
func (s *Service) ApproveBatch(ctx context.Context, ids []string, a Actor) ([]Operation, error) {
	unlock, lockErr := s.lockMutation(ctx)
	if lockErr != nil {
		return nil, lockErr
	}
	defer unlock()
	ctx = context.WithValue(ctx, mutationGuardHeld{}, true)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if a.Kind != "owner" {
		return nil, ErrForbidden
	}
	if len(ids) == 0 || len(ids) > 20 {
		return nil, ErrInvalid
	}
	ops := make([]Operation, 0, len(ids))
	seen := map[string]bool{}
	sessionID := ""
	for _, id := range ids {
		if seen[id] {
			return nil, ErrInvalid
		}
		seen[id] = true
		op, err := s.GetOperation(ctx, id, a)
		if err != nil {
			return nil, err
		}
		if op.Risk {
			return nil, fmt.Errorf("高风险操作须单独确认")
		}
		if sessionID != "" && op.SessionID != sessionID {
			return nil, ErrInvalid
		}
		sessionID = op.SessionID
		ops = append(ops, op)
	}
	expected := map[string]string{}
	for _, op := range ops {
		if op.State != "awaitingApproval" {
			continue
		}
		op.Actor.KeyID = op.CredentialID
		resolved, p, err := s.check(ctx, op.Actor, op.Name)
		if err != nil || p.Revision != op.PolicyRevision {
			return nil, ErrConflict
		}
		before, err := s.target(resolved, op.Name, op.Arguments)
		if err != nil || hash(before) != op.Fingerprint {
			return nil, ErrConflict
		}
		expected[targetKey(op)] = op.Fingerprint
	}
	// 批次清单先写入，刷新后仍可追踪本次批准的范围。
	batchID := newID("agb_")
	if err := s.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := putDocument(ctx, tx, "batch", batchID, map[string]any{"operationIds": ids, "approverId": a.ID}); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, "agent.batchApproved", batchID, "success")
	}); err != nil {
		return nil, err
	}
	result := []Operation{}
	for _, op := range ops {
		if op.State != "awaitingApproval" {
			result = append(result, op)
			continue
		}
		op.Fingerprint = expected[targetKey(op)]
		executed, err := s.execute(ctx, op, true, a, op.Fingerprint)
		if err != nil {
			return result, err
		}
		result = append(result, executed)
		if executed.State != "succeeded" {
			break
		}
		op.Actor.KeyID = op.CredentialID
		resolved, _, err := s.check(ctx, op.Actor, op.Name)
		if err != nil {
			break
		}
		after, err := s.target(resolved, op.Name, op.Arguments)
		if err != nil {
			break
		}
		expected[targetKey(op)] = hash(after)
	}
	return result, nil
}
