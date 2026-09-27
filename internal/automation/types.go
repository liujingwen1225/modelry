package automation

import (
	"context"
	"errors"
	"time"
)

var (
	ErrInvalidArgument      = errors.New("invalid automation argument")
	ErrNotFound             = errors.New("automation resource not found")
	ErrConflict             = errors.New("automation resource conflict")
	ErrNotRetryable         = errors.New("delivery is not retryable")
	ErrDeliveryCapacity     = errors.New("delivery capacity is full")
	ErrSecretNotAvailable   = errors.New("Secret is unavailable")
	ErrSecretKeyUnavailable = errors.New("Secret key is unavailable")
)

type SecretProvider interface {
	SecretMetadata(context.Context, string) (name string, configured bool, err error)
	WithSecretValue(context.Context, string, func([]byte) error) error
}

type ServiceOptions struct {
	Secrets SecretProvider
	Audits  AuditWriter
	Now     func() time.Time
}

type WebhookInput struct {
	Name            string `json:"name"`
	TargetURL       string `json:"targetUrl"`
	SigningSecretID string `json:"signingSecretId"`
}

type Webhook struct {
	ID                string    `json:"id"`
	Name              string    `json:"name"`
	TargetURL         string    `json:"targetUrl"`
	SigningSecretID   string    `json:"signingSecretId"`
	SigningSecretName string    `json:"signingSecretName"`
	SigningConfigured bool      `json:"signingConfigured"`
	Enabled           bool      `json:"enabled"`
	Revision          int64     `json:"revision"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type WebhookStatus struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
}

type EventHookInput struct {
	Name         string `json:"name"`
	CollectionID string `json:"collectionId"`
	EventType    string `json:"eventType"`
	WebhookID    string `json:"webhookId"`
}

type EventHook struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	CollectionID   string    `json:"collectionId"`
	CollectionName string    `json:"collectionName"`
	EventType      string    `json:"eventType"`
	WebhookID      string    `json:"webhookId"`
	WebhookName    string    `json:"webhookName"`
	Enabled        bool      `json:"enabled"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type EventHookStatus struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
}

type JobInput struct {
	Name      string `json:"name"`
	WebhookID string `json:"webhookId"`
	Cron      string `json:"cron"`
}

type Job struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	WebhookID     string     `json:"webhookId"`
	WebhookName   string     `json:"webhookName"`
	Cron          string     `json:"cron"`
	Enabled       bool       `json:"enabled"`
	NextRunAt     time.Time  `json:"nextRunAt"`
	LastRunAt     *time.Time `json:"lastRunAt,omitempty"`
	LastStatus    string     `json:"lastStatus,omitempty"`
	LastErrorCode string     `json:"lastErrorCode,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
}

type JobStatus struct {
	ID        string    `json:"id"`
	Enabled   bool      `json:"enabled"`
	NextRunAt time.Time `json:"nextRunAt"`
}

type Delivery struct {
	ID                 string            `json:"id"`
	SourceType         string            `json:"sourceType"`
	SourceID           string            `json:"sourceId"`
	WebhookID          string            `json:"webhookId"`
	WebhookName        string            `json:"webhookName"`
	WebhookRevision    int64             `json:"webhookRevision"`
	EventID            string            `json:"eventId,omitempty"`
	EventType          string            `json:"eventType"`
	Status             string            `json:"status"`
	CreatedAt          time.Time         `json:"createdAt"`
	NextAttemptAt      *time.Time        `json:"nextAttemptAt,omitempty"`
	CompletedAt        *time.Time        `json:"completedAt,omitempty"`
	AttemptCount       int               `json:"attemptCount"`
	ManualRedriveCount int               `json:"manualRedriveCount"`
	LastHTTPStatus     *int              `json:"lastHttpStatus,omitempty"`
	ErrorCode          string            `json:"errorCode"`
	Attempts           []DeliveryAttempt `json:"attempts,omitempty"`
}

type DeliveryAttempt struct {
	Round           int        `json:"round"`
	Attempt         int        `json:"attempt"`
	WebhookRevision int64      `json:"webhookRevision"`
	Status          string     `json:"status"`
	StartedAt       time.Time  `json:"startedAt"`
	CompletedAt     *time.Time `json:"completedAt,omitempty"`
	DurationMS      int64      `json:"durationMs"`
	HTTPStatus      *int       `json:"httpStatus,omitempty"`
	ErrorCode       string     `json:"errorCode"`
}

type DeliveryListOptions struct {
	Cursor     string
	Limit      int
	SourceType string
	Status     string
}

type DeliveryPage struct {
	Data       []Delivery `json:"data"`
	NextCursor string     `json:"nextCursor,omitempty"`
}

type ValidationViolation struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ValidationError struct{ Violations []ValidationViolation }

func (validation *ValidationError) Error() string { return ErrInvalidArgument.Error() }
func (validation *ValidationError) Unwrap() error { return ErrInvalidArgument }

func invalidField(path, code, message string) error {
	return &ValidationError{Violations: []ValidationViolation{{Path: path, Code: code, Message: message}}}
}
