package adminauth

import (
	"context"
	"github.com/liujingwen1225/modelry/internal/storage"
	"time"
)

// WithoutPrincipal 防止代表服务账号执行工具时继承批准者的 Owner 权限。
func WithoutPrincipal(ctx context.Context) context.Context {
	ctx = context.WithValue(ctx, principalContextKey{}, Principal{})
	ctx = context.WithValue(ctx, ownerContextKey{}, Owner{})
	return context.WithValue(ctx, administratorContextKey{}, Administrator{})
}

// AgentContext 仅供受控执行层恢复已保存并验证过的项目 Owner 身份。
func (s *Service) AgentContext(ctx context.Context, id, credentialID string) (context.Context, error) {
	var owner Owner
	err := s.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		return tx.QueryRowContext(ctx, `SELECT o.id,o.email FROM modelry_admin_owner o JOIN modelry_admin_sessions s ON s.owner_id=o.id WHERE o.id=? AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>?`, id, credentialID, time.Now().UTC().Unix()).Scan(&owner.ID, &owner.Email)
	})
	if err != nil {
		return ctx, err
	}
	return withPrincipal(ctx, Principal{Kind: PrincipalOwner, ID: owner.ID, Email: owner.Email, Grant: FullAccessGrant()}), nil
}

// AgentCredentialID 绑定发起任务时的登录会话，退出登录后不再恢复执行权限。
func AgentCredentialID(ctx context.Context) string {
	session, _ := ctx.Value(ownerSessionContextKey{}).(durableSession)
	return session.sessionID
}
