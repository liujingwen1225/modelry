package recordlifecycle

import (
	"context"
	"errors"

	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	ErrRuntimeUnavailable = errors.New("Extension Runtime is unavailable")
	ErrRejected           = errors.New("Extension rejected the Record change")
	ErrBudgetExceeded     = errors.New("Extension exceeded its execution budget")
	ErrInvalidOutput      = errors.New("Extension returned invalid output")
)

type Operation string

const (
	Create Operation = "create"
	Update Operation = "update"
	Delete Operation = "delete"
)

type BeforeChange struct {
	CollectionID string
	RecordID     string
	Operation    Operation
	ModelVersion int
	Values       map[string]any
	Previous     map[string]any
}

type Hooks interface {
	Before(context.Context, BeforeChange) (map[string]any, error)
	AppendIntent(context.Context, storage.Executor, recordevents.Event) error
	AfterCommit(context.Context, recordevents.Event)
}

type compositeHooks struct{ hooks []Hooks }

// Combine 按调用方给定的顺序执行同步与事务生命周期阶段，并按相同顺序发送提交后通知。
func Combine(hooks ...Hooks) Hooks {
	active := make([]Hooks, 0, len(hooks))
	for _, hook := range hooks {
		if hook != nil {
			active = append(active, hook)
		}
	}
	if len(active) == 0 {
		return nil
	}
	if len(active) == 1 {
		return active[0]
	}
	return compositeHooks{hooks: active}
}

func (composite compositeHooks) Before(ctx context.Context, change BeforeChange) (map[string]any, error) {
	for _, hook := range composite.hooks {
		values, err := hook.Before(ctx, change)
		if err != nil {
			return nil, err
		}
		change.Values = values
	}
	return change.Values, nil
}

func (composite compositeHooks) AppendIntent(ctx context.Context, tx storage.Executor, event recordevents.Event) error {
	for _, hook := range composite.hooks {
		if err := hook.AppendIntent(ctx, tx, event); err != nil {
			return err
		}
	}
	return nil
}

func (composite compositeHooks) AfterCommit(ctx context.Context, event recordevents.Event) {
	for _, hook := range composite.hooks {
		hook.AfterCommit(ctx, event)
	}
}
