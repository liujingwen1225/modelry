package authorization

import "context"

type principalContextKey struct{}

// WithPrincipal 将已通过对应认证边界验证的身份放入请求上下文。
func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalContextKey{}, principal)
}

// PrincipalFromContext 返回认证中间件写入的 Principal。
func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalContextKey{}).(Principal)
	return principal, ok
}
