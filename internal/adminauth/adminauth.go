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

// Service 提供首次 Owner、登录、Session 与保护管理路由的能力。
type Service struct {
	store *storage.Store
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
	owner     Owner
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
	session := durableSession{owner: Owner{ID: ownerID, Email: emailKey}, expiresAt: now.Add(sessionLifetime)}
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
	return session.owner, session, token, nil
}

func (service *Service) login(ctx context.Context, email, password string) (Owner, durableSession, string, error) {
	emailKey, err := normalizeEmail(email)
	if err != nil {
		return Owner{}, durableSession{}, "", validationFailure("/email", "INVALID_EMAIL", "Enter a valid email address.")
	}
	if err := validatePassword(password); err != nil {
		return Owner{}, durableSession{}, "", err
	}
	var owner Owner
	var storedHash string
	lookupErr := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		return tx.QueryRowContext(ctx, `SELECT id, email, password_hash FROM modelry_admin_owner
			WHERE singleton = ? AND email_key = ?`, ownerSingleton, emailKey).Scan(&owner.ID, &owner.Email, &storedHash)
	})
	if lookupErr != nil {
		if !errors.Is(lookupErr, sql.ErrNoRows) {
			return Owner{}, durableSession{}, "", unavailableError{cause: lookupErr}
		}
		_ = verifyPassword(password, dummyPasswordHash)
		return Owner{}, durableSession{}, "", ErrUnauthenticated
	}
	if !verifyPassword(password, storedHash) {
		return Owner{}, durableSession{}, "", ErrUnauthenticated
	}
	owner, session, token, err := service.createSession(ctx, owner)
	if err != nil {
		return Owner{}, durableSession{}, "", unavailableError{cause: err}
	}
	return owner, session, token, nil
}

func (service *Service) createSession(ctx context.Context, owner Owner) (Owner, durableSession, string, error) {
	sessionID, err := newOpaque("ses_", 16)
	if err != nil {
		return Owner{}, durableSession{}, "", err
	}
	token, tokenHash, err := newSessionToken()
	if err != nil {
		return Owner{}, durableSession{}, "", err
	}
	now := time.Now().UTC().Truncate(time.Second)
	session := durableSession{owner: owner, expiresAt: now.Add(sessionLifetime)}
	if err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_admin_sessions
			(id, owner_id, token_hash, created_at, expires_at)
			VALUES (?, ?, ?, ?, ?)`, sessionID, owner.ID, tokenHash, now.Unix(), session.expiresAt.Unix())
		return err
	}); err != nil {
		return Owner{}, durableSession{}, "", err
	}
	return owner, session, token, nil
}

func (service *Service) authenticate(ctx context.Context, token string) (durableSession, error) {
	tokenHash, ok := validSessionToken(token)
	if !ok {
		return durableSession{}, ErrUnauthenticated
	}
	var session durableSession
	now := time.Now().UTC().Unix()
	var expiresAt int64
	err := service.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		return tx.QueryRowContext(ctx, `SELECT o.id, o.email, s.expires_at
			FROM modelry_admin_sessions AS s
			JOIN modelry_admin_owner AS o ON o.id = s.owner_id
			WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`, tokenHash, now).
			Scan(&session.owner.ID, &session.owner.Email, &expiresAt)
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return durableSession{}, ErrUnauthenticated
		}
		return durableSession{}, unavailableError{cause: err}
	}
	session.expiresAt = time.Unix(expiresAt, 0).UTC()
	return session, nil
}

func (service *Service) revoke(ctx context.Context, token string) error {
	tokenHash, ok := validSessionToken(token)
	if !ok {
		return ErrUnauthenticated
	}
	now := time.Now().UTC().Unix()
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `UPDATE modelry_admin_sessions SET revoked_at = ?
			WHERE token_hash = ? AND revoked_at IS NULL`, now, tokenHash)
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
	mux.Handle("/admin/api/v1/auth/session", service.RequireOwner(methodHandler(http.MethodGet, http.HandlerFunc(service.handleSession))))
	mux.Handle("/admin/api/v1/auth/logout", service.RequireOwner(methodHandler(http.MethodPost, http.HandlerFunc(service.handleLogout))))
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
func (service *Service) Middleware(next http.Handler) http.Handler {
	protected := service.RequireOwner(next)
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

// RequireOwner validates the Owner cookie and same-origin checks unsafe browser writes.
func (service *Service) RequireOwner(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if isUnsafeMethod(request.Method) {
			if err := requireSameOrigin(request); err != nil {
				writeAuthError(w, request, &apiFault{status: http.StatusForbidden, code: "FORBIDDEN", message: "This request must come from the same origin.", hint: "Reload Modelry and retry the action."})
				return
			}
		}
		if _, ok := request.Context().Value(ownerSessionContextKey{}).(durableSession); ok {
			next.ServeHTTP(w, request)
			return
		}
		token, err := ownerCookie(request)
		if err != nil {
			writeAuthError(w, request, ErrUnauthenticated)
			return
		}
		if request.Header.Get("Authorization") != "" {
			writeAuthError(w, request, ErrUnauthenticated)
			return
		}
		session, err := service.authenticate(request.Context(), token)
		if err != nil {
			writeAuthError(w, request, err)
			return
		}
		ctx := context.WithValue(request.Context(), ownerContextKey{}, session.owner)
		ctx = context.WithValue(ctx, ownerSessionContextKey{}, session)
		next.ServeHTTP(w, request.WithContext(ctx))
	})
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
