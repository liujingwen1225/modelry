package activity

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

type fakeSource struct {
	facts []Fact
	err   error
}

func (source fakeSource) Facts(context.Context, storage.Executor, int) ([]Fact, error) {
	if source.err != nil {
		return nil, source.err
	}
	return source.facts, nil
}

type fakeStore struct{}

func (fakeStore) WithReadSnapshot(_ context.Context, work func(storage.Executor) error) error { return work(nil) }

func fact(id string, occurred time.Time, kind Kind) Fact {
	return Fact{ID: id, Kind: kind, Status: "succeeded", OccurredAt: occurred, ResourceKind: "delivery", ResourceID: id, DeepLink: "/automations?tab=deliveries"}
}

func TestActivityMergesSortsPaginatesAndFiltersWithoutOwningTables(t *testing.T) {
	ctx := context.Background()
	base := time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)
	first := []Fact{
		fact("af_a", base.Add(3*time.Minute), KindWebhookDelivery),
		fact("af_b", base.Add(2*time.Minute), KindWebhookDelivery),
	}
	second := []Fact{
		fact("af_c", base.Add(4*time.Minute), KindExtensionRun),
		fact("af_d", base.Add(time.Minute), KindMailDelivery),
	}
	service, err := NewService(fakeStore{}, fakeSource{facts: first}, fakeSource{facts: second})
	if err != nil {
		t.Fatal(err)
	}
	page, err := service.List(ctx, ListOptions{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 2 || page.Data[0].ID != "af_c" || page.Data[1].ID != "af_a" || page.NextCursor == "" {
		t.Fatalf("first page = %+v", page)
	}
	next, err := service.List(ctx, ListOptions{Limit: 2, Cursor: page.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Data) != 2 || next.Data[0].ID != "af_b" || next.Data[1].ID != "af_d" || next.NextCursor != "" {
		t.Fatalf("second page = %+v", next)
	}
	filtered, err := service.List(ctx, ListOptions{Kinds: []Kind{KindMailDelivery}})
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered.Data) != 1 || filtered.Data[0].ID != "af_d" {
		t.Fatalf("kind filter = %+v", filtered)
	}
	if _, err := service.List(ctx, ListOptions{Kinds: []Kind{Kind("debug.log")}}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unknown kind error = %v", err)
	}
	if _, err := service.List(ctx, ListOptions{Cursor: "not-a-cursor"}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("invalid cursor error = %v", err)
	}
	if _, err := service.List(ctx, ListOptions{Limit: MaximumLimit + 1}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("oversized limit error = %v", err)
	}
	failing, err := NewService(fakeStore{}, fakeSource{err: errors.New("boom")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := failing.List(ctx, ListOptions{}); !errors.Is(err, ErrStorage) {
		t.Fatalf("source failure error = %v, want ErrStorage", err)
	}
}