package requests

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestRequestRecordsAreDurableSearchableAndCursorPaged(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "project.sqlite")
	store, err := storage.Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	baseTime := time.Date(2026, 9, 24, 1, 2, 3, 0, time.UTC)
	for index, entry := range []RequestRecord{
		{RequestID: "req_aaaaaaaa", Time: baseTime, CollectionID: "col_posts", Endpoint: "/api/v1/posts", Method: "GET", Status: 200, DurationMS: 12, AuthenticationOutcome: AuthenticationAnonymous, AuthorizationOutcome: AuthorizationAllowed},
		{RequestID: "req_bbbbbbbb", Time: baseTime.Add(time.Second), CollectionID: "col_posts", Endpoint: "/api/v1/posts", Method: "POST", Status: 403, DurationMS: 7, AuthenticationOutcome: AuthenticationAuthenticated, AuthorizationOutcome: AuthorizationDenied, ErrorCode: "FORBIDDEN"},
		{RequestID: "req_cccccccc", Time: baseTime.Add(2 * time.Second), CollectionID: "col_users", Endpoint: "/api/v1/users", Method: "GET", Status: 200, DurationMS: 2, AuthenticationOutcome: AuthenticationAnonymous, AuthorizationOutcome: AuthorizationAllowed},
	} {
		entry.Time = entry.Time.Add(time.Duration(index) * time.Nanosecond)
		if err := service.Append(ctx, entry); err != nil {
			t.Fatalf("append RequestRecord %s: %v", entry.RequestID, err)
		}
	}

	page, err := service.List(ctx, ListOptions{Limit: 1, Search: "posts", Filter: "status eq 403", Sort: "time desc"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 1 || page.Data[0].RequestID != "req_bbbbbbbb" || page.Data[0].ErrorCode != "FORBIDDEN" {
		t.Fatalf("filtered RequestRecord page = %+v", page)
	}

	firstPage, err := service.List(ctx, ListOptions{Limit: 1, Search: "api/v1", Sort: "time desc"})
	if err != nil {
		t.Fatal(err)
	}
	if len(firstPage.Data) != 1 || firstPage.Data[0].RequestID != "req_cccccccc" || firstPage.NextCursor == "" {
		t.Fatalf("first RequestRecord page = %+v", firstPage)
	}
	secondPage, err := service.List(ctx, ListOptions{Limit: 1, Search: "api/v1", Sort: "time desc", Cursor: firstPage.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(secondPage.Data) != 1 || secondPage.Data[0].RequestID != "req_bbbbbbbb" {
		t.Fatalf("second RequestRecord page = %+v", secondPage)
	}

	got, err := service.Get(ctx, "req_bbbbbbbb")
	if err != nil || got.AuthorizationOutcome != AuthorizationDenied || got.ErrorCode != "FORBIDDEN" {
		t.Fatalf("Request Detail = %+v, error = %v", got, err)
	}
	if _, err := service.Get(ctx, "req_zzzzzzzz"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown Request Detail error = %v", err)
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := storage.Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	reloaded, err := NewService(ctx, restarted)
	if err != nil {
		t.Fatal(err)
	}
	got, err = reloaded.Get(ctx, "req_bbbbbbbb")
	if err != nil || got.RequestID != "req_bbbbbbbb" || got.Time.IsZero() {
		t.Fatalf("reloaded Request Detail = %+v, error = %v", got, err)
	}
}

func TestRequestRecordRejectsUnsafeMetadata(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service, err := NewService(t.Context(), store)
	if err != nil {
		t.Fatal(err)
	}
	unsafe := RequestRecord{RequestID: "req_aaaaaaaa", Time: time.Now().UTC(), Endpoint: "/api/v1/posts?token=secret", Method: "GET", Status: 200}
	if err := service.Append(t.Context(), unsafe); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("query string in Endpoint error = %v", err)
	}
	unsafe.Endpoint = "/api/v1/posts"
	unsafe.AuthenticationOutcome = "Bearer secret-token"
	if err := service.Append(t.Context(), unsafe); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unrecognized authentication outcome error = %v", err)
	}
}
