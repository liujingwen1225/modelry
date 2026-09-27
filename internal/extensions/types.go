package extensions

import (
	"context"
	"encoding/json"
	"time"
)

type Operation string

const (
	OperationCreate Operation = "create"
	OperationUpdate Operation = "update"
	OperationDelete Operation = "delete"
)

type Phase string

const (
	PhaseBefore      Phase = "before"
	PhaseAfterCommit Phase = "afterCommit"
)

type RunStatus string

const (
	RunPending     RunStatus = "pending"
	RunRunning     RunStatus = "running"
	RunSucceeded   RunStatus = "succeeded"
	RunRejected    RunStatus = "rejected"
	RunFailed      RunStatus = "failed"
	RunInterrupted RunStatus = "interrupted"
	RunCancelled   RunStatus = "cancelled"
)

type Binding struct {
	CollectionID string    `json:"collectionId"`
	Operation    Operation `json:"operation"`
	Phase        Phase     `json:"phase"`
}

type SecretBindingInput struct {
	Alias    string `json:"alias"`
	SecretID string `json:"secretId"`
}

type SecretBinding struct {
	Alias      string `json:"alias"`
	SecretID   string `json:"secretId"`
	SecretName string `json:"secretName"`
	Configured bool   `json:"configured"`
}

type ConfigInput struct {
	Name           string               `json:"name"`
	Language       Language             `json:"language"`
	Source         string               `json:"source"`
	Bindings       []Binding            `json:"bindings"`
	SecretBindings []SecretBindingInput `json:"secretBindings"`
	AllowedOrigins []string             `json:"allowedOrigins"`
}

// ValidationViolation 描述一个可安全呈现给用户的配置问题。
type ValidationViolation struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ValidationError 包含不会泄露 Extension 源码或 Secret 的字段问题。
type ValidationError struct {
	Violations []ValidationViolation
}

func (validation *ValidationError) Error() string { return ErrValidation.Error() }
func (validation *ValidationError) Unwrap() error { return ErrValidation }

// BindingConflictError 标识已被其他启用扩展占用的绑定槽。
type BindingConflictError struct {
	CollectionID string
	Operation    Operation
	Phase        Phase
}

func (conflict *BindingConflictError) Error() string { return ErrBindingConflict.Error() }
func (conflict *BindingConflictError) Unwrap() error { return ErrBindingConflict }

func invalidField(path, code, message string) error {
	return &ValidationError{Violations: []ValidationViolation{{Path: path, Code: code, Message: message}}}
}

type Summary struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	Language           Language  `json:"language"`
	ActiveRevision     int64     `json:"activeRevision"`
	Enabled            bool      `json:"enabled"`
	BindingCount       int       `json:"bindingCount"`
	SecretBindingCount int       `json:"secretBindingCount"`
	OriginGrantCount   int       `json:"originGrantCount"`
	CreatedAt          time.Time `json:"-"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

type Detail struct {
	Summary
	CreatedAt      time.Time       `json:"createdAt"`
	Source         string          `json:"source"`
	Bindings       []Binding       `json:"bindings"`
	SecretBindings []SecretBinding `json:"secretBindings"`
	AllowedOrigins []string        `json:"allowedOrigins"`
}

type Run struct {
	RunID         string     `json:"runId"`
	ExtensionID   string     `json:"extensionId"`
	Revision      int64      `json:"revision"`
	CollectionID  string     `json:"collectionId"`
	RecordID      string     `json:"recordId,omitempty"`
	EventID       string     `json:"eventId,omitempty"`
	Operation     Operation  `json:"operation"`
	Phase         Phase      `json:"phase"`
	Status        RunStatus  `json:"status"`
	StartedAt     time.Time  `json:"startedAt"`
	CompletedAt   *time.Time `json:"completedAt,omitempty"`
	DurationMS    int64      `json:"durationMs"`
	ErrorCode     string     `json:"errorCode"`
	CorrelationID string     `json:"correlationId,omitempty"`
}

type RunPage struct {
	Data       []Run  `json:"data"`
	NextCursor string `json:"nextCursor,omitempty"`
}

type RunListOptions struct {
	Cursor string
	Limit  int
}

type SecretMetadata struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Configured bool      `json:"configured"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type SecretLookup func(context.Context, string) (string, error)
type HTTPRequest func(context.Context, json.RawMessage) (json.RawMessage, error)

// Invocation 仅通过 JSON 数据跨越 Extension Host 边界。
type Invocation struct {
	Code         string
	Phase        string
	Context      json.RawMessage
	SecretLookup SecretLookup
	HTTPRequest  HTTPRequest
}

type Invoker interface {
	Invoke(context.Context, Invocation) (json.RawMessage, error)
}
