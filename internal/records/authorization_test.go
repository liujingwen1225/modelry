package records

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/recordlifecycle"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type testEvaluator struct{}

func (testEvaluator) Evaluate(_ context.Context, _ string, _ authorization.Operation, _ authorization.Principal, record *authorization.Record) (authorization.Decision, error) {
	if record == nil || record.Values["visible"] == true {
		return authorization.Decision{Allowed: true}, nil
	}
	return authorization.Decision{Code: "POLICY_DENIED", Message: "hidden"}, nil
}

func (evaluator testEvaluator) EvaluateInTransaction(ctx context.Context, _ storage.Executor, collectionID string, operation authorization.Operation, principal authorization.Principal, record *authorization.Record) (authorization.Decision, error) {
	return evaluator.Evaluate(ctx, collectionID, operation, principal, record)
}

type denySecondEvaluation struct{ calls atomic.Int32 }

func (evaluator *denySecondEvaluation) decision() authorization.Decision {
	if evaluator.calls.Add(1) == 1 {
		return authorization.Decision{Allowed: true}
	}
	return authorization.Decision{Code: "POLICY_DENIED", Message: "rule changed"}
}

func (evaluator *denySecondEvaluation) Evaluate(context.Context, string, authorization.Operation, authorization.Principal, *authorization.Record) (authorization.Decision, error) {
	return evaluator.decision(), nil
}

func (evaluator *denySecondEvaluation) EvaluateInTransaction(context.Context, storage.Executor, string, authorization.Operation, authorization.Principal, *authorization.Record) (authorization.Decision, error) {
	return evaluator.decision(), nil
}

type denyAfterTwoEvaluations struct{ calls atomic.Int32 }

func (evaluator *denyAfterTwoEvaluations) decision() authorization.Decision {
	if evaluator.calls.Add(1) <= 2 {
		return authorization.Decision{Allowed: true}
	}
	return authorization.Decision{Code: "POLICY_DENIED", Message: "rule changed"}
}

func (evaluator *denyAfterTwoEvaluations) Evaluate(context.Context, string, authorization.Operation, authorization.Principal, *authorization.Record) (authorization.Decision, error) {
	return evaluator.decision(), nil
}

func (evaluator *denyAfterTwoEvaluations) EvaluateInTransaction(context.Context, storage.Executor, string, authorization.Operation, authorization.Principal, *authorization.Record) (authorization.Decision, error) {
	return evaluator.decision(), nil
}

type passThroughLifecycle struct{}

func (passThroughLifecycle) Before(_ context.Context, change recordlifecycle.BeforeChange) (map[string]any, error) {
	return change.Values, nil
}

func (passThroughLifecycle) AppendIntent(context.Context, storage.Executor, recordevents.Event) error {
	return nil
}

func (passThroughLifecycle) AfterCommit(context.Context, recordevents.Event) {}

type testSessionAuthenticator struct{}

func (testSessionAuthenticator) AuthenticateSession(_ context.Context, token string) (authorization.Principal, error) {
	if token != "valid" {
		return authorization.Principal{}, errors.New("bad token")
	}
	return authorization.Principal{Type: authorization.PrincipalApplication, ID: "usr_1"}, nil
}

func TestApplicationRecordsFailClosedAndFilterRows(t *testing.T) {
	ctx := context.Background()
	store, models, adminRecords := newTestServices(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "entries", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "visible", Type: backendmodel.FieldTypeBoolean}, {Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := adminRecords.Create(ctx, collection.ID, map[string]any{"title": "shown", "visible": true}); err != nil {
		t.Fatal(err)
	}
	hidden, err := adminRecords.Create(ctx, collection.ID, map[string]any{"title": "hidden", "visible": false})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := adminRecords.ListApplication(ctx, collection.ID, ListOptions{}, authorization.Principal{Type: authorization.PrincipalAnonymous}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Application List with missing evaluator error = %v", err)
	}
	appRecords, err := New(store, models, WithAuthorization(testEvaluator{}, testSessionAuthenticator{}))
	if err != nil {
		t.Fatal(err)
	}
	page, err := appRecords.ListApplication(ctx, collection.ID, ListOptions{Limit: 1, Sort: "title asc"}, authorization.Principal{Type: authorization.PrincipalAnonymous})
	if err != nil {
		t.Fatalf("Application List: %v", err)
	}
	if len(page.Data) != 1 || page.Data[0].Values["title"] != "shown" {
		t.Fatalf("Application List returned unauthorized rows: %+v", page.Data)
	}
	if _, err := appRecords.GetApplication(ctx, collection.ID, hidden.ID, authorization.Principal{Type: authorization.PrincipalAnonymous}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Application Get for hidden record error = %v", err)
	}
}

func TestApplicationBearerCredentialNeverFallsBackToAnonymous(t *testing.T) {
	_, _, service := newTestServices(t)
	request, _ := http.NewRequest(http.MethodGet, "/api/v1/posts", nil)
	principal, err := service.AuthenticateApplicationRequest(context.Background(), request)
	if err != nil || principal.Type != authorization.PrincipalAnonymous {
		t.Fatalf("missing credential principal=%+v error=%v", principal, err)
	}
	request.Header.Set("Authorization", "Bearer invalid")
	if _, err := service.AuthenticateApplicationRequest(context.Background(), request); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("invalid supplied credential error = %v", err)
	}
	service.sessions = testSessionAuthenticator{}
	request.Header.Set("Authorization", "Bearer valid")
	principal, err = service.AuthenticateApplicationRequest(context.Background(), request)
	if err != nil || principal.Type != authorization.PrincipalApplication || principal.ID != "usr_1" {
		t.Fatalf("valid credential principal=%+v error=%v", principal, err)
	}
}

func TestApplicationDeleteReauthorizesInsideMutationTransaction(t *testing.T) {
	ctx := context.Background()
	store, models, adminRecords := newTestServices(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "protected", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	created, err := adminRecords.Create(ctx, collection.ID, map[string]any{"title": "keep"})
	if err != nil {
		t.Fatal(err)
	}
	evaluator := &denySecondEvaluation{}
	applicationRecords, err := New(store, models, WithAuthorization(evaluator, nil))
	if err != nil {
		t.Fatal(err)
	}
	err = applicationRecords.DeleteApplication(ctx, collection.ID, created.ID, authorization.Principal{Type: authorization.PrincipalAnonymous})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("DeleteApplication error = %v, want denied after in-transaction rule recheck", err)
	}
	if evaluator.calls.Load() != 2 {
		t.Fatalf("authorization evaluations = %d, want preflight and transaction checks", evaluator.calls.Load())
	}
	if _, err := adminRecords.Get(ctx, collection.ID, created.ID); err != nil {
		t.Fatalf("denied DeleteApplication removed the Record: %v", err)
	}
}

func TestApplicationCreateReauthorizesInsideMutationTransactionWithLifecycle(t *testing.T) {
	ctx := context.Background()
	store, models, adminRecords := newTestServices(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "protectedCreates", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	events, err := recordevents.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	evaluator := &denyAfterTwoEvaluations{}
	applicationRecords, err := New(store, models,
		WithAuthorization(evaluator, nil),
		WithRecordEvents(events),
		WithLifecycleHooks(passThroughLifecycle{}),
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = applicationRecords.CreateApplication(ctx, collection.ID, map[string]any{"title": "must-not-persist"}, authorization.Principal{Type: authorization.PrincipalAnonymous})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("CreateApplication error = %v, want denied after in-transaction rule recheck", err)
	}
	if evaluator.calls.Load() != 3 {
		t.Fatalf("authorization evaluations = %d, want preflight, post-Hook, and transaction checks", evaluator.calls.Load())
	}
	page, err := adminRecords.List(ctx, collection.ID, ListOptions{Limit: 10})
	if err != nil || len(page.Data) != 0 {
		t.Fatalf("denied CreateApplication persisted a Record: page=%+v err=%v", page, err)
	}
	position, err := events.State(ctx, collection.ID)
	if err != nil || position.Head != 0 {
		t.Fatalf("denied CreateApplication persisted an Event: position=%+v err=%v", position, err)
	}
}

func TestApplicationListCursorNeverExposesDeniedRecordValues(t *testing.T) {
	ctx := context.Background()
	store, models, adminRecords := newTestServices(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "cursorItems", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}, {Name: "visible", Type: backendmodel.FieldTypeBoolean}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, values := range []map[string]any{
		{"title": "alpha visible", "visible": true},
		{"title": "SECRET_HIDDEN_VALUE", "visible": false},
		{"title": "zulu visible", "visible": true},
	} {
		if _, err := adminRecords.Create(ctx, collection.ID, values); err != nil {
			t.Fatal(err)
		}
	}
	applicationRecords, err := New(store, models, WithAuthorization(testEvaluator{}, nil))
	if err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{Type: authorization.PrincipalAnonymous}
	firstPage, err := applicationRecords.ListApplication(ctx, collection.ID, ListOptions{Limit: 1, Sort: "title asc"}, principal)
	if err != nil {
		t.Fatal(err)
	}
	if len(firstPage.Data) != 1 || firstPage.Data[0].Values["title"] != "alpha visible" || firstPage.NextCursor == "" {
		t.Fatalf("first filtered page = %+v", firstPage)
	}
	decodedCursor, err := base64.RawURLEncoding.DecodeString(firstPage.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(decodedCursor), "SECRET_HIDDEN_VALUE") {
		t.Fatalf("application cursor exposed a denied record sort value: %s", decodedCursor)
	}
	secondPage, err := applicationRecords.ListApplication(ctx, collection.ID, ListOptions{Limit: 1, Sort: "title asc", Cursor: firstPage.NextCursor}, principal)
	if err != nil {
		t.Fatal(err)
	}
	if len(secondPage.Data) != 1 || secondPage.Data[0].Values["title"] != "zulu visible" || secondPage.NextCursor != "" {
		t.Fatalf("second filtered page = %+v", secondPage)
	}
}
