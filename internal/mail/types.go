// Package mail 提供 Project Mail Provider 配置与 durable Mail Delivery outbox。
// 外发 SMTP 永远不在 SQLite 事务内执行；凭据按次解密且从不落库。
package mail

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrInvalidArgument 表示配置或投递输入不合法。
	ErrInvalidArgument = errors.New("invalid mail argument")
	// ErrNotFound 表示投递或配置不存在。
	ErrNotFound = errors.New("mail resource not found")
	// ErrConflict 表示配置版本冲突。
	ErrConflict = errors.New("mail configuration conflict")
	// ErrNotConfigured 表示 Mail Provider 未启用或配置不完整。
	ErrNotConfigured = errors.New("mail provider is not configured")
	// ErrCredentialUnavailable 表示引用的 Secret 缺失或无法解密。
	ErrCredentialUnavailable = errors.New("mail credential unavailable")
	// ErrUnavailable 表示 SMTP 连接、认证或发送失败。
	ErrUnavailable = errors.New("mail provider unavailable")
	// ErrCapacity 表示待投递队列已满。
	ErrCapacity = errors.New("mail delivery capacity exceeded")
)

// ProviderSecurity 是 SMTP 传输安全模式。
type ProviderSecurity string

const (
	SecurityStartTLS ProviderSecurity = "startTLS"
	SecurityTLS      ProviderSecurity = "tls"
)

// 单次投递尝试与队列的固定上限。
const (
	MaximumAttemptsPerDelivery = 8
	MaximumPendingDeliveries   = 1000
	MaximumRetainedDeliveries  = 5000
	AttemptInterval            = 30 * time.Second
	DeliveryTimeout            = 20 * time.Second
	DialTimeout                = 10 * time.Second
	MaximumMessageBytes        = 512 << 10
)

// Config 是 Project Mail Provider 配置；凭据只保存 Secret ID。
type Config struct {
	Enabled          bool
	Host             string
	Port             int
	Security         ProviderSecurity
	FromAddress      string
	FromName         string
	UsernameSecretID string
	PasswordSecretID string
	Revision         int
	UpdatedAt        time.Time
}

// Configured 判断配置是否完整到可以发出邮件。
func (config Config) Configured() bool {
	return config.Enabled && config.Host != "" && config.Port > 0 && config.FromAddress != "" &&
		config.UsernameSecretID != "" && config.PasswordSecretID != ""
}

// DeliveryKind 是一次外发邮件的用途。
type DeliveryKind string

const (
	KindTest          DeliveryKind = "test"
	KindVerification  DeliveryKind = "verification"
	KindPasswordReset DeliveryKind = "passwordReset"
)

// DeliveryStatus 是投递的耐久状态。
type DeliveryStatus string

const (
	DeliveryPending     DeliveryStatus = "pending"
	DeliveryRunning     DeliveryStatus = "running"
	DeliverySucceeded   DeliveryStatus = "succeeded"
	DeliveryFailed      DeliveryStatus = "failed"
	DeliveryCancelled   DeliveryStatus = "cancelled"
	DeliveryInterrupted DeliveryStatus = "interrupted"
)

// 安全错误码：永不包含 SMTP 响应正文或凭据。
const (
	ErrorNone              = ""
	ErrorProviderDisabled  = "providerDisabled"
	ErrorCredentialMissing = "credentialUnavailable"
	ErrorConnectFailed     = "connectFailed"
	ErrorAuthentication    = "authenticationFailed"
	ErrorRejected          = "recipientRejected"
	ErrorAttemptExhausted  = "attemptsExhausted"
	ErrorInterrupted       = "interrupted"
	ErrorPayloadInvalid    = "payloadInvalid"
)

// Delivery 是一次耐久投递的安全投影。
type Delivery struct {
	ID            string
	Kind          DeliveryKind
	Recipient     string
	PayloadRef    string
	Status        DeliveryStatus
	Attempts      int
	NextAttemptAt *time.Time
	ErrorCode     string
	CreatedAt     time.Time
	CompletedAt   *time.Time
}

// Message 是已经渲染好的外发邮件内容；它只存在于内存中。
type Message struct {
	From      string
	FromName  string
	To        string
	Subject   string
	Body      string
	MessageID string
	Date      time.Time
}

// Credentials 是一次投递尝试内解密得到的 SMTP 凭据。
type Credentials struct {
	Username string
	Password string
}

// Sender 发送一封邮件；实现必须是 bounded 且不泄漏凭据。
type Sender interface {
	Send(ctx context.Context, config Config, credentials Credentials, message Message) error
}

// SecretProvider 解析 Project Secret；明文只在回调期间可见。
type SecretProvider interface {
	SecretMetadata(ctx context.Context, secretID string) (string, bool, error)
	WithSecretValue(ctx context.Context, secretID string, use func([]byte) error) error
}

// PayloadSource 渲染一次投递的邮件内容；它不持久化 token 或正文。
type PayloadSource interface {
	RenderDeliveryPayload(ctx context.Context, kind DeliveryKind, payloadRef, recipient string) (subject string, body string, err error)
}
