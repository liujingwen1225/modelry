package appauth

import (
	"context"

	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// EmailVerificationMode 决定 Auth Collection 是否要求 App User 验证邮箱。
type EmailVerificationMode string

const (
	// EmailVerificationOff 保持 V0.1 行为：注册即可登录，不做验证。
	EmailVerificationOff EmailVerificationMode = "off"
	// EmailVerificationOptional 允许验证但不阻塞登录。
	EmailVerificationOptional EmailVerificationMode = "optional"
	// EmailVerificationRequired 在验证前拒绝登录。
	EmailVerificationRequired EmailVerificationMode = "required"
)

// AuthConfig 是一个 Auth Collection 已应用或待应用的认证配置。
type AuthConfig struct {
	EmailPasswordEnabled bool                  `json:"emailPasswordEnabled"`
	SelfRegistration     bool                  `json:"selfRegistration"`
	SessionDurationDays  int                   `json:"sessionDurationDays"`
	EmailVerification    EmailVerificationMode `json:"emailVerification,omitempty"`
}

type AuthConfigSaveInput struct {
	ExpectedVersion int        `json:"expectedVersion"`
	Configuration   AuthConfig `json:"configuration"`
}

type AuthConfigState struct {
	Applied    AuthConfig `json:"applied"`
	Pending    AuthConfig `json:"pending"`
	Version    int        `json:"version"`
	HasPending bool       `json:"-"`
}

type ApplicationUser struct {
	RecordID string `json:"recordId"`
	Email    string `json:"email"`
}

type ApplicationUserPage struct {
	Data       []ApplicationUser `json:"data"`
	NextCursor string            `json:"nextCursor,omitempty"`
}

type ApplicationSession struct {
	ID         string  `json:"id"`
	CreatedAt  string  `json:"createdAt"`
	ExpiresAt  string  `json:"expiresAt"`
	Status     string  `json:"status"`
	LastUsedAt *string `json:"lastUsedAt,omitempty"`
}

type LoginResult struct {
	AccessToken string             `json:"accessToken"`
	TokenType   string             `json:"tokenType"`
	Session     ApplicationSession `json:"session"`
}

type Violation struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ValidationFailure struct {
	Violation Violation
}

func (failure *ValidationFailure) Error() string { return failure.Violation.Message }

func (failure *ValidationFailure) Unwrap() error { return ErrInvalidArgument }

// ProfileWriter 让 Auth 域通过调用方事务原子创建 Profile Record 与 Credential。
type ProfileWriter interface {
	CreateInTransaction(context.Context, storage.Executor, string, map[string]any) (records.Record, error)
	Get(context.Context, string, string) (records.Record, error)
	List(context.Context, string, records.ListOptions) (records.Page, error)
}
