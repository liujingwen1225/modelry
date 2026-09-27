package recordlifecycle

import (
	"context"
	"reflect"
	"testing"

	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type recordingHook struct {
	name  string
	order *[]string
}

func (hook recordingHook) Before(_ context.Context, change BeforeChange) (map[string]any, error) {
	*hook.order = append(*hook.order, hook.name+".before")
	values := make(map[string]any, len(change.Values)+1)
	for key, value := range change.Values {
		values[key] = value
	}
	values[hook.name] = true
	return values, nil
}

func (hook recordingHook) AppendIntent(context.Context, storage.Executor, recordevents.Event) error {
	*hook.order = append(*hook.order, hook.name+".intent")
	return nil
}

func (hook recordingHook) AfterCommit(context.Context, recordevents.Event) {
	*hook.order = append(*hook.order, hook.name+".after")
}

func TestCombineRunsBeforeAndIntentsInOrderAndNotifiesAllHooks(t *testing.T) {
	order := make([]string, 0, 6)
	combined := Combine(recordingHook{name: "extension", order: &order}, recordingHook{name: "automation", order: &order})
	values, err := combined.Before(context.Background(), BeforeChange{Values: map[string]any{"title": "post"}})
	if err != nil || !reflect.DeepEqual(values, map[string]any{"title": "post", "extension": true, "automation": true}) {
		t.Fatalf("combined Before() = %#v, %v", values, err)
	}
	if err := combined.AppendIntent(context.Background(), nil, recordevents.Event{ID: "evt_1"}); err != nil {
		t.Fatal(err)
	}
	combined.AfterCommit(context.Background(), recordevents.Event{ID: "evt_1"})
	want := []string{"extension.before", "automation.before", "extension.intent", "automation.intent", "extension.after", "automation.after"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("combined lifecycle order = %v, want %v", order, want)
	}
}
