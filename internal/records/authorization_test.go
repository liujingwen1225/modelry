package records

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
)

type testEvaluator struct{}

func (testEvaluator) Evaluate(_ context.Context, _ string, _ authorization.Operation, _ authorization.Principal, record *authorization.Record) (authorization.Decision, error) {
	if record == nil || record.Values["visible"] == true {
		return authorization.Decision{Allowed: true}, nil
	}
	return authorization.Decision{Code: "POLICY_DENIED", Message: "hidden"}, nil
}

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
