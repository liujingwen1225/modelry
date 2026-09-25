package accesscontrol

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
)

// TestSimulationUsesTheRuntimeEvaluatorAndStaysNonAuthoritative 证明模拟与真实评估使用同一 evaluator，
// 结果标注非权威，并且不产生任何写入。
func TestSimulationUsesTheRuntimeEvaluatorAndStaysNonAuthoritative(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "project.sqlite")
	store := openTestStore(t, databasePath)
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, models)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Posts", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	rules := emptyRules()
	for index, rule := range rules {
		if rule.Operation == authorization.OperationList {
			rules[index] = Rule{Operation: authorization.OperationList, Mode: ModeAnyone}
		}
	}
	if _, err := service.Save(ctx, collection.ID, SaveInput{ExpectedVersion: 1, Rules: rules}); err != nil {
		t.Fatal(err)
	}
	state, err := service.Apply(ctx, collection.ID, 2)
	if err != nil {
		t.Fatal(err)
	}

	result, err := service.Simulate(ctx, collection.ID, SimulationInput{
		Operation: authorization.OperationList,
		Principal: authorization.Principal{Type: authorization.PrincipalAnonymous},
	})
	if err != nil {
		t.Fatalf("simulate anonymous list: %v", err)
	}
	if !result.Allowed || result.Authoritative || result.DecidingMode != string(ModeAnyone) || result.Notice == "" {
		t.Fatalf("simulation result = %+v", result)
	}

	denied, err := service.Simulate(ctx, collection.ID, SimulationInput{
		Operation: authorization.OperationDelete,
		Principal: authorization.Principal{Type: authorization.PrincipalAnonymous},
	})
	if err != nil {
		t.Fatalf("simulate anonymous delete: %v", err)
	}
	if denied.Allowed || denied.Authoritative || denied.DecidingMode != string(ModeNoAccess) {
		t.Fatalf("denied simulation result = %+v", denied)
	}
	real, err := service.Evaluate(ctx, collection.ID, authorization.OperationDelete, authorization.Principal{Type: authorization.PrincipalAnonymous}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if real.Allowed != denied.Allowed || real.Code != denied.Code {
		t.Fatalf("simulation diverged from the runtime evaluator: simulated=%+v real=%+v", denied, real)
	}

	after, err := service.Get(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != state.Version || after.HasPending {
		t.Fatalf("simulation wrote to the Access Rule state: before=%d after=%+v", state.Version, after)
	}

	if _, err := service.Simulate(ctx, collection.ID, SimulationInput{
		Operation: authorization.Operation("purge"),
		Principal: authorization.Principal{Type: authorization.PrincipalAnonymous},
	}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unknown operation error = %v, want ErrInvalidArgument", err)
	}
	if _, err := service.Simulate(ctx, collection.ID, SimulationInput{
		Operation: authorization.OperationList,
		Principal: authorization.Principal{Type: authorization.PrincipalType("robot"), ID: "x"},
	}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unknown principal error = %v, want ErrInvalidArgument", err)
	}
	if _, err := service.Simulate(ctx, collection.ID, SimulationInput{
		Operation: authorization.OperationList,
		Principal: authorization.Principal{Type: authorization.PrincipalApplication, ID: "rec_1"},
		RecordID:  "rec_1",
		Payload:   map[string]any{"title": "x"},
	}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("recordId plus payload error = %v, want ErrInvalidArgument", err)
	}
	if _, err := service.Simulate(ctx, "col_missing", SimulationInput{
		Operation: authorization.OperationList,
		Principal: authorization.Principal{Type: authorization.PrincipalAnonymous},
	}); !errors.Is(err, ErrCollectionNotFound) {
		t.Fatalf("unknown collection error = %v, want ErrCollectionNotFound", err)
	}
}