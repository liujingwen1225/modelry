package serviceaccounts

import (
	"context"
	"database/sql"
	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/storage"
	"time"
)

// AgentContext 重新读取服务账号与发起密钥，不保存明文、不借用批准者权限。
func (s *Service) AgentContext(ctx context.Context, id, keyID string) (context.Context, error) {
	var grant Grant
	err := s.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		row, err := readAccount(ctx, tx, id)
		if err != nil || row.Account.Status != AccountActive {
			return ErrUnauthenticated
		}
		var status string
		var expires sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT status,expires_at FROM modelry_service_account_api_keys WHERE id=? AND service_account_id=?`, keyID, id).Scan(&status, &expires); err != nil {
			return ErrUnauthenticated
		}
		if status != "active" {
			return ErrUnauthenticated
		}
		if expires.Valid {
			deadline, err := time.Parse(time.RFC3339Nano, expires.String)
			if err != nil || !deadline.After(s.now()) {
				return ErrUnauthenticated
			}
		}
		grant = row.Grant
		return nil
	})
	if err != nil {
		return ctx, err
	}
	ctx = adminauth.WithoutPrincipal(ctx)
	ctx = authorization.WithPrincipal(ctx, authorization.Principal{Type: authorization.PrincipalServiceAccount, ID: id})
	ctx = context.WithValue(ctx, grantContextKey{}, permissionGrant{accountID: id, grant: grant})
	return audit.WithActor(ctx, audit.Actor{Kind: audit.ActorServiceAccount, ID: id}), nil
}
