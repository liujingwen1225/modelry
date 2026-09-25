package audit

import (
	"context"
	"errors"
	"time"
)

var (
	ErrInvalidArgument = errors.New("invalid Audit record argument")
	ErrNotFound        = errors.New("Audit record not found")
	ErrStorage         = errors.New("Audit storage unavailable")
)

type ActorKind string

const (
	ActorOwner          ActorKind = "owner"
	ActorAdministrator  ActorKind = "administrator"
	ActorServiceAccount ActorKind = "serviceAccount"
	ActorAppUser        ActorKind = "appUser"
)

type Actor struct {
	Kind ActorKind `json:"kind"`
	ID   string    `json:"id"`
}

type Resource struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type Record struct {
	ID        string    `json:"id"`
	RequestID string    `json:"requestId,omitempty"`
	Time      time.Time `json:"time"`
	Actor     Actor     `json:"actor"`
	Action    string    `json:"action"`
	Resource  Resource  `json:"resource"`
	Result    string    `json:"result"`
}

type AppendInput struct {
	ID        string
	RequestID string
	Time      time.Time
	Actor     Actor
	Action    string
	Resource  Resource
	Result    string
}

type ListOptions struct {
	Limit        int
	Cursor       string
	Search       string
	ActorKind    ActorKind
	ActorID      string
	Action       string
	ResourceKind string
	ResourceID   string
	From         *time.Time
	To           *time.Time
}

type Page struct {
	Data       []Record `json:"data"`
	NextCursor string   `json:"nextCursor,omitempty"`
}

type contextActorKey struct{}

// WithActor 把已认证的 Control Plane Actor 放入领域调用上下文。
func WithActor(ctx context.Context, actor Actor) context.Context {
	return context.WithValue(ctx, contextActorKey{}, actor)
}
