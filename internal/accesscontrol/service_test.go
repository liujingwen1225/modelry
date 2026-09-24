package accesscontrol

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestAccessRulesFailClosedUntilAppliedAndSurviveRestart(t *testing.T) {
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
	state, err := service.Get(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Version != 1 || state.HasPending || len(state.Applied) != 5 || state.Applied[0].Mode != ModeNoAccess {
		t.Fatalf("Collection did not start with five durable fail-closed rules: %+v", state)
	}
	decision, err := service.Evaluate(ctx, collection.ID, authorization.OperationList, authorization.Principal{Type: authorization.PrincipalAnonymous}, nil)
	if err != nil || decision.Allowed || decision.Code != "FORBIDDEN" || len(decision.Reason) == 0 {
		t.Fatalf("missing initial rule should deny with a structured reason: decision=%+v err=%v", decision, err)
	}

	rules := cloneTestRules(state.Applied)
	rules[0].Mode = ModeAnyone
	pending, err := service.Save(ctx, collection.ID, SaveInput{ExpectedVersion: state.Version, Rules: rules})
	if err != nil {
		t.Fatal(err)
	}
	if !pending.HasPending || pending.Version != 2 || pending.Pending[0].Mode != ModeAnyone {
		t.Fatalf("saved Access Rule did not become durable pending state: %+v", pending)
	}
	decision, err = service.Evaluate(ctx, collection.ID, authorization.OperationList, authorization.Principal{Type: authorization.PrincipalAnonymous}, nil)
	if err != nil || decision.Allowed {
		t.Fatalf("unapplied rule changed runtime authorization: decision=%+v err=%v", decision, err)
	}
	if _, err := service.Apply(ctx, collection.ID, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale Access Rule Apply should conflict: %v", err)
	}
	state, err = service.Apply(ctx, collection.ID, pending.Version)
	if err != nil || state.HasPending || state.Applied[0].Mode != ModeAnyone {
		t.Fatalf("Apply did not promote Access Rules atomically: state=%+v err=%v", state, err)
	}
	decision, err = service.Evaluate(ctx, collection.ID, authorization.OperationList, authorization.Principal{Type: authorization.PrincipalAnonymous}, nil)
	if err != nil || !decision.Allowed {
		t.Fatalf("applied Anyone rule should allow anonymous List: decision=%+v err=%v", decision, err)
	}

	rules = cloneTestRules(state.Applied)
	rules[0].Mode = ModeSignedInUsers
	pending, err = service.Save(ctx, collection.ID, SaveInput{ExpectedVersion: state.Version, Rules: rules})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	restartedStore := openTestStore(t, databasePath)
	restartedModels, err := backendmodel.NewService(ctx, restartedStore)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := NewService(ctx, restartedStore, restartedModels)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := restarted.Get(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.HasPending || reloaded.Version != pending.Version || reloaded.Pending[0].Mode != ModeSignedInUsers || reloaded.Applied[0].Mode != ModeAnyone {
		t.Fatalf("Access Rule applied or pending state did not survive restart: %+v", reloaded)
	}
	if _, err := restarted.Discard(ctx, collection.ID, reloaded.Version); err != nil {
		t.Fatal(err)
	}
	afterDiscard, err := restarted.Get(ctx, collection.ID)
	if err != nil || afterDiscard.HasPending || afterDiscard.Applied[0].Mode != ModeAnyone {
		t.Fatalf("Discard changed applied rules or left pending state: state=%+v err=%v", afterDiscard, err)
	}
}

func TestAccessRuleModesAndCustomPredicatesFailClosed(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	users, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Users", Type: backendmodel.CollectionTypeAuth})
	if err != nil {
		t.Fatal(err)
	}
	posts, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "Posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{
			{Name: "author", Type: backendmodel.FieldTypeRelation, Relation: &backendmodel.Relation{TargetCollectionID: users.ID, Cardinality: "many-to-one"}},
			{Name: "visibility", Type: backendmodel.FieldTypeText},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, models)
	if err != nil {
		t.Fatal(err)
	}
	state, err := service.Get(ctx, posts.ID)
	if err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{Type: authorization.PrincipalApplication, ID: "rec_owner_1"}
	ownerRules := cloneTestRules(state.Applied)
	ownerRules[0] = Rule{Operation: authorization.OperationList, Mode: ModeRecordOwner, OwnerFieldID: fieldID(posts.Fields, "author")}
	ownerRules[1] = Rule{Operation: authorization.OperationView, Mode: ModeRecordOwner, OwnerFieldID: fieldID(posts.Fields, "author")}
	state, err = service.Save(ctx, posts.ID, SaveInput{ExpectedVersion: state.Version, Rules: ownerRules})
	if err != nil {
		t.Fatal(err)
	}
	state, err = service.Apply(ctx, posts.ID, state.Version)
	if err != nil {
		t.Fatal(err)
	}
	owned := &authorization.Record{ID: "rec_post_1", Values: map[string]any{"author": principal.ID}}
	decision, err := service.Evaluate(ctx, posts.ID, authorization.OperationView, principal, owned)
	if err != nil || !decision.Allowed {
		t.Fatalf("Record owner rule should allow the owner: decision=%+v err=%v", decision, err)
	}
	decision, err = service.Evaluate(ctx, posts.ID, authorization.OperationList, principal, nil)
	if err != nil || !decision.Allowed || string(decision.Reason) == "" || !strings.Contains(string(decision.Reason), "ACCESS_RULE_ROW_FILTER_REQUIRED") {
		t.Fatalf("owner List gate should require downstream per-record checks: decision=%+v err=%v", decision, err)
	}
	other := &authorization.Record{ID: "rec_post_2", Values: map[string]any{"author": "rec_owner_2"}}
	decision, err = service.Evaluate(ctx, posts.ID, authorization.OperationView, principal, other)
	if err != nil || decision.Allowed {
		t.Fatalf("Record owner rule should deny another user: decision=%+v err=%v", decision, err)
	}
	serviceAccount := authorization.Principal{Type: authorization.PrincipalServiceAccount, ID: "svc_1"}
	decision, err = service.Evaluate(ctx, posts.ID, authorization.OperationView, serviceAccount, owned)
	if err != nil || decision.Allowed {
		t.Fatalf("a Service Account must not impersonate an App User owner: decision=%+v err=%v", decision, err)
	}

	customRules := cloneTestRules(state.Applied)
	customRules[0] = Rule{
		Operation: authorization.OperationList, Mode: ModeCustom,
		Expression: json.RawMessage(`{"version":1,"all":[{"fieldId":"` + fieldID(posts.Fields, "visibility") + `","operator":"eq","value":"public"}]}`),
	}
	state, err = service.Save(ctx, posts.ID, SaveInput{ExpectedVersion: state.Version, Rules: customRules})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Apply(ctx, posts.ID, state.Version); err != nil {
		t.Fatal(err)
	}
	decision, err = service.Evaluate(ctx, posts.ID, authorization.OperationList, authorization.Principal{Type: authorization.PrincipalAnonymous}, &authorization.Record{Values: map[string]any{"visibility": "public"}})
	if err != nil || !decision.Allowed {
		t.Fatalf("matching typed Custom predicate should allow: decision=%+v err=%v", decision, err)
	}
	decision, err = service.Evaluate(ctx, posts.ID, authorization.OperationList, authorization.Principal{Type: authorization.PrincipalAnonymous}, &authorization.Record{Values: map[string]any{"visibility": "private"}})
	if err != nil || decision.Allowed {
		t.Fatalf("nonmatching typed Custom predicate should deny: decision=%+v err=%v", decision, err)
	}
}

func TestSaveRejectsUnknownCustomExpressionAndInitializerIsAtomic(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Items", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, models)
	if err != nil {
		t.Fatal(err)
	}
	state, err := service.Get(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	rules := cloneTestRules(state.Applied)
	rules[0] = Rule{Operation: authorization.OperationList, Mode: ModeCustom, Expression: json.RawMessage(`{"sql":"1=1"}`)}
	if _, err := service.Save(ctx, collection.ID, SaveInput{ExpectedVersion: state.Version, Rules: rules}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("arbitrary/unknown Custom expression should be rejected: %v", err)
	}

	initialRules := cloneTestRules(state.Applied)
	initialRules[0].Mode = ModeAnyone
	created, err := models.CreateCollectionWithInitializer(ctx, backendmodel.CreateCollectionInput{Name: "PublicItems", Type: backendmodel.CollectionTypeNormal}, func(ctx context.Context, tx storage.Executor, collection backendmodel.Collection) error {
		return InitializeCollection(ctx, tx, collection, initialRules)
	})
	if err != nil {
		t.Fatal(err)
	}
	initialState, err := service.Get(ctx, created.ID)
	if err != nil || initialState.HasPending || initialState.Applied[0].Mode != ModeAnyone {
		t.Fatalf("create-time applied Access Rules were not persisted: state=%+v err=%v", initialState, err)
	}
	var rolledBackCollectionID string
	failedCollection, err := models.CreateCollectionWithInitializer(ctx, backendmodel.CreateCollectionInput{Name: "RejectedRules", Type: backendmodel.CollectionTypeNormal}, func(ctx context.Context, tx storage.Executor, collection backendmodel.Collection) error {
		rolledBackCollectionID = collection.ID
		return InitializeCollection(ctx, tx, collection, []Rule{{Operation: authorization.OperationList, Mode: ModeAnyone}})
	})
	if err == nil || failedCollection.ID != "" {
		t.Fatalf("incomplete initial rules should fail atomically: collection=%+v err=%v", failedCollection, err)
	}
	if _, err := models.GetCollection(ctx, rolledBackCollectionID); !errors.Is(err, backendmodel.ErrNotFound) {
		t.Fatalf("failed initializer left a Collection behind: %v", err)
	}
}

func TestAccessRulesHTTPHasDurableVersionedSaveApplyDiscardAndStructuredErrors(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "HTTPItems", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, models)
	if err != nil {
		t.Fatal(err)
	}
	server := httpapi.NewHandler(nil, nil, httpapi.NewAPIRouter(NewModule(service)))
	doRequest := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		return response
	}
	path := "/admin/api/v1/collections/" + collection.ID + "/access-rules"
	response := doRequest(http.MethodGet, path, "")
	if response.Code != http.StatusOK {
		t.Fatalf("Get Access Rules status=%d body=%s", response.Code, response.Body.String())
	}
	var initialResponse struct {
		Data RulesState `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &initialResponse); err != nil {
		t.Fatal(err)
	}
	initial := initialResponse.Data
	if len(initial.Applied) != 5 || initial.Version != 1 {
		t.Fatalf("unexpected initial HTTP response: %+v", initial)
	}

	rules := cloneTestRules(initial.Applied)
	rules[0].Mode = ModeAnyone
	encoded, err := json.Marshal(SaveInput{ExpectedVersion: initial.Version, Rules: rules})
	if err != nil {
		t.Fatal(err)
	}
	response = doRequest(http.MethodPut, path, string(encoded))
	var pendingResponse struct {
		Data RulesState `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &pendingResponse) != nil || pendingResponse.Data.Version != 2 || pendingResponse.Data.Pending[0].Mode != ModeAnyone || pendingResponse.Data.Applied[0].Mode != ModeNoAccess {
		t.Fatalf("Save did not return applied and pending versions: status=%d state=%+v body=%s", response.Code, pendingResponse.Data, response.Body.String())
	}
	response = doRequest(http.MethodPost, path+"/apply", `{"expectedVersion":1}`)
	var conflict struct {
		Error httpapi.APIError `json:"error"`
	}
	if response.Code != http.StatusConflict || json.Unmarshal(response.Body.Bytes(), &conflict) != nil || conflict.Error.Code != "CONFLICT" || conflict.Error.RequestID == "" || conflict.Error.RequestID != response.Header().Get("X-Request-Id") {
		t.Fatalf("stale Apply did not return correlated structured Conflict: status=%d body=%s", response.Code, response.Body.String())
	}
	response = doRequest(http.MethodPost, path+"/apply", `{"expectedVersion":2}`)
	var appliedResponse struct {
		Data RulesState `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &appliedResponse) != nil || appliedResponse.Data.Version != 3 || appliedResponse.Data.Applied[0].Mode != ModeAnyone || appliedResponse.Data.Pending[0].Mode != ModeAnyone {
		t.Fatalf("Apply did not return durable applied state: status=%d state=%+v body=%s", response.Code, appliedResponse.Data, response.Body.String())
	}
	applied := appliedResponse.Data

	rules = cloneTestRules(applied.Applied)
	rules[0].Mode = ModeSignedInUsers
	encoded, err = json.Marshal(SaveInput{ExpectedVersion: applied.Version, Rules: rules})
	if err != nil {
		t.Fatal(err)
	}
	response = doRequest(http.MethodPut, path, string(encoded))
	if response.Code != http.StatusOK {
		t.Fatalf("Save before Discard status=%d body=%s", response.Code, response.Body.String())
	}
	response = doRequest(http.MethodPost, path+"/discard", `{"expectedVersion":4}`)
	var discardedResponse struct {
		Data RulesState `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &discardedResponse) != nil || discardedResponse.Data.Version != 5 || discardedResponse.Data.Applied[0].Mode != ModeAnyone || discardedResponse.Data.Pending[0].Mode != ModeAnyone {
		t.Fatalf("Discard did not preserve applied state: status=%d state=%+v body=%s", response.Code, discardedResponse.Data, response.Body.String())
	}
	discarded := discardedResponse.Data

	invalidRules := cloneTestRules(discarded.Applied)
	invalidRules[0] = Rule{Operation: authorization.OperationList, Mode: ModeCustom, Expression: json.RawMessage(`{"sql":"1=1"}`)}
	encoded, err = json.Marshal(SaveInput{ExpectedVersion: discarded.Version, Rules: invalidRules})
	if err != nil {
		t.Fatal(err)
	}
	response = doRequest(http.MethodPut, path, string(encoded))
	conflict = struct {
		Error httpapi.APIError `json:"error"`
	}{}
	if response.Code != http.StatusUnprocessableEntity || json.Unmarshal(response.Body.Bytes(), &conflict) != nil || conflict.Error.Code != "VALIDATION_FAILED" || conflict.Error.RequestID == "" || conflict.Error.RequestID != response.Header().Get("X-Request-Id") || len(conflict.Error.Details["violations"].([]any)) != 1 {
		t.Fatalf("invalid Custom expression did not return a correlated structured validation error: status=%d body=%s", response.Code, response.Body.String())
	}

	response = doRequest(http.MethodPut, path, `{"expectedVersion":5,"rules":[],"sql":"DROP TABLE x"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown request fields were not rejected: status=%d body=%s", response.Code, response.Body.String())
	}
}

func openTestStore(t *testing.T, databasePath string) *storage.Store {
	t.Helper()
	store, err := storage.Open(databasePath)
	if err != nil {
		t.Fatalf("open real SQLite database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func cloneTestRules(rules []Rule) []Rule {
	cloned := make([]Rule, len(rules))
	for index, rule := range rules {
		cloned[index] = rule
		cloned[index].Expression = append(json.RawMessage(nil), rule.Expression...)
	}
	return cloned
}

func fieldID(fields []backendmodel.Field, name string) string {
	for _, field := range fields {
		if field.Name == name {
			return field.ID
		}
	}
	return ""
}
