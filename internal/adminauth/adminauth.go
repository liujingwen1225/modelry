package adminauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/permissions"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const (
	ownerCookieName = "modelry_admin_session"
	ownerCookiePath = "/admin/api/v1"
	sessionLifetime = 24 * time.Hour
	ownerSingleton  = 1
)

var (
	ErrUnauthenticated = errors.New("owner authentication is required")
	ErrBootstrapClosed = errors.New("owner bootstrap is closed")
)

// Owner 是 V0.1 唯一的 Control Plane 管理身份。
type Owner struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

type ownerContextKey struct{}
type ownerSessionContextKey struct{}

// OwnerFromContext 返回已通过 RequireOwner 验证的 Owner 身份。
func OwnerFromContext(ctx context.Context) (Owner, bool) {
	owner, ok := ctx.Value(ownerContextKey{}).(Owner)
	return owner, ok
}

// ControlPlaneFact 是一个 Control Plane 安全事实；adminauth 不依赖 Audit 实现。
type ControlPlaneFact struct {
	ActorKind    string
	ActorID      string
	Action       string
	ResourceKind string
	ResourceID   string
	Result       string
}

// AuditSink 由 Runtime 注入，用于写入 Control Plane 安全事实。
type AuditSink interface {
	AppendControlPlaneFact(ctx context.Context, fact ControlPlaneFact) error
	AppendControlPlaneFactInTransaction(ctx context.Context, tx storage.Executor, fact ControlPlaneFact) error
}

// Service 提供首次 Owner、登录、Session、Administrator 与保护管理路由的能力。
type Service struct {
	store *storage.Store
	sink  AuditSink
}

// SetAuditSink 在 Runtime 启动阶段注入 Audit 边界。
func (service *Service) SetAuditSink(sink AuditSink) {
	if service != nil {
		service.sink = sink
	}
}

func (service *Service) appendControlPlaneAudit(ctx context.Context, tx storage.Executor, action, resourceID string) error {
	if service == nil || service.sink == nil {
		return nil
	}
	principal, ok := PrincipalFromContext(ctx)
	if !ok {
		return nil
	}
	return service.sink.AppendControlPlaneFactInTransaction(ctx, tx, ControlPlaneFact{
		ActorKind: string(principal.Kind), ActorID: principal.ID, Action: action,
		ResourceKind: "administrator", ResourceID: resourceID, Result: "success",
	})
}

// New 初始化管理面认证的耐久结构；同一 Store 必须由 Runtime 统一持有。
func New(store *storage.Store) (*Service, error) {
	if store == nil {
		return nil, errors.New("admin authentication requires an open project store")
	}
	service := &Service{store: store}
	if err := store.WithTransaction(context.Background(), func(tx storage.Executor) error {
		statements := []string{
			`CREATE TABLE IF NOT EXISTS modelry_admin_owner (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				id TEXT NOT NULL UNIQUE,
				email TEXT NOT NULL,
				email_key TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS modelry_admin_bootstrap (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				closed INTEGER NOT NULL CHECK (closed IN (0, 1))
			)`,
			`INSERT OR IGNORE INTO modelry_admin_bootstrap (singleton, closed)
				SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM modelry_admin_owner) THEN 1 ELSE 0 END`,
			`UPDATE modelry_admin_bootstrap SET closed = 1
				WHERE EXISTS (SELECT 1 FROM modelry_admin_owner)`,
			`CREATE TABLE IF NOT EXISTS modelry_admin_sessions (
				id TEXT PRIMARY KEY,
				owner_id TEXT NOT NULL REFERENCES modelry_admin_owner(id),
				token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				revoked_at INTEGER
			)`,
			`CREATE INDEX IF NOT EXISTS modelry_admin_sessions_expiry_idx
				ON modelry_admin_sessions (expires_at)`,
			administratorSchema,
			administratorSessionSchema,
			`CREATE INDEX IF NOT EXISTS modelry_administrator_sessions_expiry_idx
				ON modelry_administrator_sessions (expires_at)`,
		}
		for _, statement := range statements {
			if _, err := tx.ExecContext(context.Background(), statement); err != nil {
				return fmt.Errorf("initialize admin authentication storage: %w", err)
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return service, nil
}

func normalizeEmail(email string) (string, error) {
	email = strings.TrimSpace(email)
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email || !strings.Contains(email, "@") {
		return "", errors.New("email is invalid")
	}
	return strings.ToLower(email), nil
}

func newOpaque(prefix string, size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate opaque identity: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value), nil
}

func newSessionToken() (string, []byte, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", nil, fmt.Errorf("generate owner session token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(value)
	hash := sha256.Sum256([]byte(token))
	return token, hash[:], nil
}

func validSessionToken(token string) ([]byte, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != token {
		return nil, false
	}
	hash := sha256.Sum256([]byte(token))
	return hash[:], true
}

type durableSession struct {
	principal Principal
	sessionID string
	expiresAt time.Time
}
func (service *Service) bootstrap(ctx context.Context, email, password string) (Owner, durableSession, string, error) {
	emailKey, err := normalizeEmail(email)
	if err != nil {
		return Owner{}, durableSession{}, "", validationFailure("/email", "INVALID_EMAIL", "Enter a valid email address.")
	}
	if err := validatePassword(password); err != nil {
		return Owner{}, durableSession{}, "", err
	}
	var closed int
	if err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		return tx.QueryRowContext(ctx, `SELECT closed FROM modelry_admin_bootstrap WHERE singleton = ?`, ownerSingleton).Scan(&closed)
	}); err != nil {
		return Owner{}, durableSession{}, "", unavailableError{cause: err}
	}
	if closed != 0 {
		return Owner{}, durableSession{}, "", ErrBootstrapClosed
	}
	passwordHash, err := derivePasswordHash(password)
	if err != nil {
		return Owner{}, durableSession{}, "", fmt.Errorf("derive owner credential: %w", err)
	}
	ownerID, err := newOpaque("own_", 16)
	if err != nil {
		return Owner{}, durableSession{}, "", err
	}
	sessionID, err := newOpaque("ses_", 16)
	if err != nil {
		return Owner{}, durableSession{}, "", err
	}
	token, tokenHash, err := newSessionToken()
	if err != nil {
		return Owner{}, durableSession{}, "", err
	}
	now := time.Now().UTC().Truncate(time.Second)
	session := durableSession{principal: Principal{Kind: PrincipalOwner, ID: ownerID, Email: emailKey, Grant: FullAccessGrant()}, sessionID: sessionID, expiresAt: now.Add(sessionLifetime)}
	err = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE modelry_admin_bootstrap SET closed = 1
			WHERE singleton = 1 AND closed = 0
			AND NOT EXISTS (SELECT 1 FROM modelry_admin_owner)`)
		if err != nil {
			return err
		}
		rows, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if rows != 1 {
			return ErrBootstrapClosed
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_admin_owner
			(singleton, id, email, email_key, password_hash, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`, ownerSingleton, ownerID, emailKey, emailKey, passwordHash, now.Unix()); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO modelry_admin_sessions
			(id, owner_id, token_hash, created_at, expires_at)
			VALUES (?, ?, ?, ?, ?)`, sessionID, ownerID, tokenHash, now.Unix(), session.expiresAt.Unix())
		return err
	})
	if err != nil {
		if errors.Is(err, ErrBootstrapClosed) {
			return Owner{}, durableSession{}, "", err
		}
		err = unavailableError{cause: err}
		return Owner{}, durableSession{}, "", err
	}
	return Owner{ID: session.principal.ID, Email: session.principal.Email}, session, token, nil
}

func (service *Service) login(ctx context.Context, email, password string) (Principal, durableSession, string, error) {
	emailKey, err := normalizeEmail(email)
	if err != nil {
		return Principal{}, durableSession{}, "", validationFailure("/email", "INVALID_EMAIL", "Enter a valid email address.")
	}
	if err := validatePassword(password); err != nil {
		return Principal{}, durableSession{}, "", err
	}
	var owner Owner
	var storedHash string
	lookupErr := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		return tx.QueryRowContext(ctx, "SELECT id, email, password_hash FROM modelry_admin_owner WHERE singleton = ? AND email_key = ?", ownerSingleton, emailKey).Scan(&owner.ID, &owner.Email, &storedHash)
	})
	switch {
	case lookupErr == nil:
		if !verifyPassword(password, storedHash) {
			return Principal{}, durableSession{}, "", ErrUnauthenticated
		}
		principal := Principal{Kind: PrincipalOwner, ID: owner.ID, Email: owner.Email, Grant: FullAccessGrant()}
		session, token, err := service.createSession(ctx, principal)
		if err != nil {
			return Principal{}, durableSession{}, "", unavailableError{cause: err}
		}
		return principal, session, token, nil
	case errors.Is(lookupErr, sql.ErrNoRows):
		principal, session, token, found, err := service.loginAdministrator(ctx, emailKey, password)
		if err != nil {
			return Principal{}, durableSession{}, "", err
		}
		if found {
			return principal, session, token, nil
		}
		_ = verifyPassword(password, dummyPasswordHash)
		return Principal{}, durableSession{}, "", ErrUnauthenticated
	default:
		return Principal{}, durableSession{}, "", unavailableError{cause: lookupErr}
	}
}

func (service *Service) createSession(ctx context.Context, principal Principal) (durableSession, string, error) {
	sessionID, err := newOpaque("ses_", 16)
	if err != nil {
		return durableSession{}, "", err
	}
	token, tokenHash, err := newSessionToken()
	if err != nil {
		return durableSession{}, "", err
	}
	now := time.Now().UTC().Truncate(time.Second)
	session := durableSession{principal: principal, sessionID: sessionID, expiresAt: now.Add(sessionLifetime)}
	if err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO modelry_admin_sessions (id, owner_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", sessionID, principal.ID, tokenHash, now.Unix(), session.expiresAt.Unix())
		return err
	}); err != nil {
		return durableSession{}, "", err
	}
	return session, token, nil
}

func (service *Service) authenticate(ctx context.Context, token string) (durableSession, error) {
	tokenHash, ok := validSessionToken(token)
	if !ok {
		return durableSession{}, ErrUnauthenticated
	}
	nowUnix := time.Now().UTC().Unix()
	var session durableSession
	var ownerID, ownerEmail string
	var ownerExpires int64
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		return tx.QueryRowContext(ctx, "SELECT o.id, o.email, s.id, s.expires_at FROM modelry_admin_sessions AS s JOIN modelry_admin_owner AS o ON o.id = s.owner_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?", tokenHash, nowUnix).
			Scan(&ownerID, &ownerEmail, &session.sessionID, &ownerExpires)
	})
	if err == nil {
		session.principal = Principal{Kind: PrincipalOwner, ID: ownerID, Email: ownerEmail, Grant: FullAccessGrant()}
		session.expiresAt = time.Unix(ownerExpires, 0).UTC()
		return session, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return durableSession{}, unavailableError{cause: err}
	}
	var administratorID, administratorEmail, status, preset, encoded string
	var version int
	var expiresAt int64
	var lastUsedNull sql.NullInt64
	err = service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		return tx.QueryRowContext(ctx, "SELECT a.id, a.email, a.status, a.permission_preset, a.permission_version, a.permission_operations, s.id, s.expires_at, s.last_used_at FROM modelry_administrator_sessions AS s JOIN modelry_administrators AS a ON a.id = s.administrator_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?", tokenHash, nowUnix).
			Scan(&administratorID, &administratorEmail, &status, &preset, &version, &encoded, &session.sessionID, &expiresAt, &lastUsedNull)
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return durableSession{}, ErrUnauthenticated
		}
		return durableSession{}, unavailableError{cause: err}
	}
	if AdministratorStatus(status) != AdministratorActive {
		return durableSession{}, ErrUnauthenticated
	}
	grant, err := permissionFromColumns(preset, version, encoded)
	if err != nil {
		return durableSession{}, unavailableError{cause: err}
	}
	session.principal = Principal{Kind: PrincipalAdministrator, ID: administratorID, Email: administratorEmail, Grant: grant}
	session.expiresAt = time.Unix(expiresAt, 0).UTC()
	lastUsed := int64(0)
	if lastUsedNull.Valid {
		lastUsed = lastUsedNull.Int64
	}
	if nowUnix-lastUsed > 60 {
		_ = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
			_, err := tx.ExecContext(ctx, "UPDATE modelry_administrator_sessions SET last_used_at = ? WHERE id = ?", nowUnix, session.sessionID)
			return err
		})
	}
	return session, nil
}

func (service *Service) revoke(ctx context.Context, token string) error {
	tokenHash, ok := validSessionToken(token)
	if !ok {
		return ErrUnauthenticated
	}
	now := time.Now().UTC().Unix()
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, "UPDATE modelry_admin_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", now, tokenHash); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE modelry_administrator_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", now, tokenHash)
		return err
	})
	if err != nil {
		return unavailableError{cause: err}
	}
	return nil
}

// RegisterRoutes 把 Bootstrap 与 Owner Session 的 HTTP 路由注册到共享 mux。
func (service *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("/admin/api/v1/bootstrap/status", methodHandler(http.MethodGet, http.HandlerFunc(service.handleBootstrapStatus)))
	mux.Handle("/admin/api/v1/bootstrap/owner", methodHandler(http.MethodPost, http.HandlerFunc(service.handleBootstrapOwner)))
	mux.Handle("/admin/api/v1/auth/login", methodHandler(http.MethodPost, http.HandlerFunc(service.handleLogin)))
	mux.Handle("/admin/api/v1/auth/session", service.RequirePrincipal(methodHandler(http.MethodGet, http.HandlerFunc(service.handleSession))))
	mux.Handle("/admin/api/v1/auth/logout", service.RequirePrincipal(methodHandler(http.MethodPost, http.HandlerFunc(service.handleLogout))))
	service.RegisterAdministratorRoutes(mux)
}

func methodHandler(method string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != method {
			writeAuthError(w, request, &apiFault{status: http.StatusNotFound, code: "NOT_FOUND", message: "The requested API endpoint was not found."})
			return
		}
		next.ServeHTTP(w, request)
	})
}

// Middleware protects Control Plane routes while leaving Application routes and
// the explicitly public first-run / diagnostics endpoints to their own contracts.
// Administrator 请求在进入模块之前按 Permission fail closed。
func (service *Service) Middleware(next http.Handler) http.Handler {
	protected := service.RequirePrincipal(next)
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if !strings.HasPrefix(request.URL.Path, "/admin/api/v1/") && request.URL.Path != "/admin/api/v1" {
			next.ServeHTTP(w, request)
			return
		}
		if isPublicAdminPath(request) {
			next.ServeHTTP(w, request)
			return
		}
		protected.ServeHTTP(w, request)
	})
}

func isPublicAdminPath(request *http.Request) bool {
	switch request.URL.Path {
	case "/admin/api/v1/bootstrap/status", "/admin/api/v1/bootstrap/owner", "/admin/api/v1/auth/login":
		return true
	case "/admin/api/v1/runtime/status", "/admin/api/v1/storage/status":
		return request.Method == http.MethodGet && request.Header.Get("Authorization") == "" && request.Header.Get("Cookie") == ""
	default:
		return false
	}
}

// RequirePrincipal 认证 Owner 或 Administrator Cookie，并对 Administrator 强制 Permission。
func (service *Service) RequirePrincipal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if isUnsafeMethod(request.Method) {
			if err := requireSameOrigin(request); err != nil {
				writeAuthError(w, request, &apiFault{status: http.StatusForbidden, code: "FORBIDDEN", message: "This request must come from the same origin.", hint: "Reload Modelry and retry the action."})
				return
			}
		}
		session, ok := request.Context().Value(ownerSessionContextKey{}).(durableSession)
		if !ok {
			token, err := ownerCookie(request)
			if err != nil {
				writeAuthError(w, request, ErrUnauthenticated)
				return
			}
			if request.Header.Get("Authorization") != "" {
				writeAuthError(w, request, ErrUnauthenticated)
				return
			}
			session, err = service.authenticate(request.Context(), token)
			if err != nil {
				writeAuthError(w, request, err)
				return
			}
		}
		principal := session.principal
		if principal.Kind == PrincipalAdministrator {
			operation, found := permissions.ControlPlaneOperation(request.Method, request.URL.Path)
			denied := !found || OwnerOnlyResources(operation) || !principal.Allows(operation)
			if denied {
				service.recordDeniedControlPlaneRequest(request.Context(), principal, operation, request)
				hint := "Ask the Owner to grant the required Permission."
				if !found || OwnerOnlyResources(operation) {
					hint = "This Control Plane resource is managed by the Owner."
				}
				writeAuthError(w, request, &apiFault{status: http.StatusForbidden, code: "FORBIDDEN", message: "This Administrator does not have Permission for this Control Plane operation.", hint: hint})
				return
			}
		}
		ctx := withPrincipal(request.Context(), principal)
		ctx = context.WithValue(ctx, ownerSessionContextKey{}, session)
		next.ServeHTTP(w, request.WithContext(ctx))
	})
}

func (service *Service) recordDeniedControlPlaneRequest(ctx context.Context, principal Principal, operation permissions.Operation, request *http.Request) {
	if service == nil || service.sink == nil {
		return
	}
	resourceID := string(operation)
	if resourceID == "" {
		resourceID = "unmapped"
	}
	_ = service.sink.AppendControlPlaneFact(ctx, ControlPlaneFact{
		ActorKind: string(principal.Kind), ActorID: principal.ID, Action: "controlPlane.denied",
		ResourceKind: "controlPlaneOperation", ResourceID: resourceID, Result: "denied",
	})
}

// RequireOwner 只在当前请求由 Owner 发起时继续，供 Owner-only 资源使用。
func (service *Service) RequireOwner(next http.Handler) http.Handler {
	return service.RequirePrincipal(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if _, ok := OwnerFromContext(request.Context()); !ok {
			writeAuthError(w, request, &apiFault{status: http.StatusForbidden, code: "FORBIDDEN", message: "Only the Owner can perform this action.", hint: "Ask the Owner to change this configuration."})
			return
		}
		next.ServeHTTP(w, request)
	}))
}

func isUnsafeMethod(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
}

func ownerCookie(request *http.Request) (string, error) {
	var token string
	count := 0
	for _, cookie := range request.Cookies() {
		if cookie.Name == ownerCookieName {
			token = cookie.Value
			count++
		}
	}
	if count != 1 || token == "" {
		return "", ErrUnauthenticated
	}
	return token, nil
}
