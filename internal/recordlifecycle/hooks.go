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
