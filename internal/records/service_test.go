package records

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func newTestServices(t *testing.T) (*storage.Store, *backendmodel.Service, *Service) {
	t.Helper()
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatalf("open real SQLite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close SQLite store: %v", err)
		}
	})
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatalf("initialize Backend Model: %v", err)
	}
	service, err := New(store, models)
	if err != nil {
		t.Fatalf("initialize Records Service: %v", err)
	}
	return store, models, service
}

func TestRecordCRUDDurableAndSystemFieldsManaged(t *testing.T) {
	ctx := context.Background()
	_, models, records := newTestServices(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{
			{Name: "title", Type: backendmodel.FieldTypeText, Required: true},
			{Name: "rank", Type: backendmodel.FieldTypeNumber},
			{Name: "published", Type: backendmodel.FieldTypeBoolean},
			{Name: "metadata", Type: backendmodel.FieldTypeJSON},
		},
	})
	if err != nil {
		t.Fatalf("create applied Collection: %v", err)
	}
	created, err := records.Create(ctx, collection.ID, map[string]any{
		"title": "first", "rank": json.Number("12.5"), "published": true,
		"metadata": map[string]any{"source": "admin"},
	})
	if err != nil {
		t.Fatalf("create Record: %v", err)
	}
	if created.ID == "" || created.CreatedAt == "" || created.UpdatedAt != created.CreatedAt {
		t.Fatalf("Runtime-managed fields were not generated: %+v", created)
	}
	if _, err := records.Create(ctx, collection.ID, map[string]any{"title": "bad", "id": "user-set"}); !errors.Is(err, backendmodel.ErrInvalidArgument) && !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("system field write error = %v", err)
	}
	got, err := records.Get(ctx, collection.ID, created.ID)
	if err != nil {
		t.Fatalf("get Record: %v", err)
	}
	if got.Values["title"] != "first" || got.Values["published"] != true || got.Values["rank"] != json.Number("12.5") {
		t.Fatalf("read Record values = %#v", got.Values)
	}
	updated, err := records.Update(ctx, collection.ID, created.ID, map[string]any{"title": "changed"})
	if err != nil {
		t.Fatalf("update Record: %v", err)
	}
	if updated.Values["title"] != "changed" || updated.Values["published"] != true || updated.UpdatedAt == created.UpdatedAt {
		t.Fatalf("update did not preserve omitted values or advance updatedAt: %+v", updated)
	}
	if err := records.Delete(ctx, collection.ID, created.ID); err != nil {
		t.Fatalf("delete Record: %v", err)
	}
	if _, err := records.Get(ctx, collection.ID, created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get deleted Record error = %v", err)
	}
}

type allowAllTestEvaluator struct{}

func (allowAllTestEvaluator) Evaluate(context.Context, string, authorization.Operation, authorization.Principal, *authorization.Record) (authorization.Decision, error) {
	return authorization.Decision{Allowed: true}, nil
}

func TestAuthCollectionGenericAdminWritesRequireAuthUserFlow(t *testing.T) {
	ctx := context.Background()
	store, models, adminRecords := newTestServices(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "users", Type: backendmodel.CollectionTypeAuth,
		Fields: []backendmodel.Field{{Name: "displayName", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}

	var profile Record
	err = store.WithTransaction(ctx, func(tx storage.Executor) error {
		var createErr error
		profile, createErr = adminRecords.CreateInTransaction(ctx, tx, collection.ID, map[string]any{"email": "one@example.test"})
		return createErr
	})
	if err != nil {
		t.Fatalf("create Auth Profile through its transaction seam: %v", err)
	}
	if _, err := adminRecords.Create(ctx, collection.ID, map[string]any{"email": "two@example.test"}); !errors.Is(err, ErrAuthCollectionWriteRequiresAuthAPI) {
		t.Fatalf("generic Admin create error = %v", err)
	}
	if _, err := adminRecords.Update(ctx, collection.ID, profile.ID, map[string]any{"displayName": "Changed"}); !errors.Is(err, ErrAuthCollectionWriteRequiresAuthAPI) {
		t.Fatalf("generic Admin update error = %v", err)
	}
	if err := adminRecords.Delete(ctx, collection.ID, profile.ID); !errors.Is(err, ErrAuthCollectionWriteRequiresAuthAPI) {
		t.Fatalf("generic Admin delete error = %v", err)
	}
	if _, err := adminRecords.Get(ctx, collection.ID, profile.ID); err != nil {
		t.Fatalf("generic Admin read should remain available: %v", err)
	}

	applicationRecords, err := New(store, models, WithAuthorization(allowAllTestEvaluator{}, nil))
	if err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{Type: authorization.PrincipalApplication, ID: "usr_test"}
	if _, err := applicationRecords.UpdateApplication(ctx, collection.ID, profile.ID, map[string]any{"displayName": "Changed"}, principal); err != nil {
		t.Fatalf("authorized Application update should follow applied Access Rules: %v", err)
	}
	created, err := applicationRecords.CreateApplication(ctx, collection.ID, map[string]any{"email": "two@example.test"}, principal)
	if err != nil {
		t.Fatalf("authorized Application create should follow applied Access Rules: %v", err)
	}
	if err := applicationRecords.DeleteApplication(ctx, collection.ID, created.ID, principal); err != nil {
		t.Fatalf("authorized Application delete should follow applied Access Rules: %v", err)
	}
}

func TestRecordListSearchFilterSortAndCursor(t *testing.T) {
	ctx := context.Background()
	_, models, records := newTestServices(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "entries", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}},
	})
	if err != nil {
		t.Fatalf("create applied Collection: %v", err)
	}
	for _, title := range []string{"Alpha", "beta", "Alphabet", "literal % value"} {
		if _, err := records.Create(ctx, collection.ID, map[string]any{"title": title}); err != nil {
			t.Fatalf("create %q: %v", title, err)
		}
	}
	page, err := records.List(ctx, collection.ID, ListOptions{Limit: 1, Sort: "title asc"})
	if err != nil {
		t.Fatalf("list sorted Records: %v", err)
	}
	if len(page.Data) != 1 || page.Data[0].Values["title"] != "Alpha" || page.NextCursor == "" {
		t.Fatalf("first sorted page = %+v", page)
	}
	second, err := records.List(ctx, collection.ID, ListOptions{Limit: 1, Sort: "title asc", Cursor: page.NextCursor})
	if err != nil {
		t.Fatalf("list second cursor page: %v", err)
	}
	if len(second.Data) != 1 || second.Data[0].Values["title"] != "Alphabet" {
		t.Fatalf("second sorted page = %+v", second)
	}
	search, err := records.List(ctx, collection.ID, ListOptions{Search: "alp", Sort: "title asc"})
	if err != nil || len(search.Data) != 2 {
		t.Fatalf("search results = %+v, error = %v", search, err)
	}
	filtered, err := records.List(ctx, collection.ID, ListOptions{Filter: `title eq "beta"`})
	if err != nil || len(filtered.Data) != 1 || filtered.Data[0].Values["title"] != "beta" {
		t.Fatalf("filter results = %+v, error = %v", filtered, err)
	}
	literal, err := records.List(ctx, collection.ID, ListOptions{Search: "%"})
	if err != nil || len(literal.Data) != 1 || literal.Data[0].Values["title"] != "literal % value" {
		t.Fatalf("escaped search results = %+v, error = %v", literal, err)
	}
	if _, err := records.List(ctx, collection.ID, ListOptions{Sort: `title desc; SELECT 1`}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unsafe sort error = %v", err)
	}
	if _, err := records.List(ctx, collection.ID, ListOptions{Filter: `title eq "beta" OR 1=1`}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unsafe filter error = %v", err)
	}
}

func TestRelationReferencesValidatedAndTargetDeleteRestricted(t *testing.T) {
	ctx := context.Background()
	_, models, records := newTestServices(t)
	authors, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "authors", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "name", Type: backendmodel.FieldTypeText, Required: true}},
	})
	if err != nil {
		t.Fatalf("create authors: %v", err)
	}
	posts, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "posts", Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}, {
			Name: "author", Type: backendmodel.FieldTypeRelation,
			Relation: &backendmodel.Relation{TargetCollectionID: authors.ID, Cardinality: "many-to-one"},
		}, {
			Name: "reviewers", Type: backendmodel.FieldTypeRelation,
			Relation: &backendmodel.Relation{TargetCollectionID: authors.ID, Cardinality: "many-to-many"},
		}},
	})
	if err != nil {
		t.Fatalf("create posts: %v", err)
	}
	author, err := records.Create(ctx, authors.ID, map[string]any{"name": "Ada"})
	if err != nil {
		t.Fatalf("create target Record: %v", err)
	}
	post, err := records.Create(ctx, posts.ID, map[string]any{"title": "Relation", "author": author.ID, "reviewers": []any{author.ID}})
	if err != nil {
		t.Fatalf("create related Record: %v", err)
	}
	if _, err := records.Create(ctx, posts.ID, map[string]any{"title": "Missing", "author": "rec_missing"}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("missing relation target error = %v", err)
	}
	if err := records.Delete(ctx, authors.ID, author.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete referenced target error = %v", err)
	}
	got, err := records.Get(ctx, posts.ID, post.ID)
	if err != nil {
		t.Fatalf("read related Record: %v", err)
	}
	if got.Values["author"] != author.ID {
		t.Fatalf("single relation value = %#v", got.Values["author"])
	}
	reviewers, ok := got.Values["reviewers"].([]any)
	if !ok || len(reviewers) != 1 || reviewers[0] != author.ID {
		t.Fatalf("many relation value = %#v", got.Values["reviewers"])
	}
	if err := records.Delete(ctx, posts.ID, post.ID); err != nil {
		t.Fatalf("delete source Record: %v", err)
	}
	if err := records.Delete(ctx, authors.ID, author.ID); err != nil {
		t.Fatalf("delete unreferenced target Record: %v", err)
	}
}
