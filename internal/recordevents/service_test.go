package recordevents

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func openService(t *testing.T) (*storage.Store, *Service) {
	t.Helper()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatalf("open storage: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close storage: %v", err)
		}
	})
	service, err := NewService(context.Background(), store)
	if err != nil {
		t.Fatalf("create event service: %v", err)
	}
	return store, service
}

func TestEventIDsEncodeOpaqueCollectionAndParseNonzeroSequences(t *testing.T) {
	collectionID := "Catalog/Notes_雪"
	eventID, err := EventID(collectionID, 10)
	if err != nil {
		t.Fatalf("create Event ID: %v", err)
	}
	if got, want := eventID[:4], "evt_"; got != want {
		t.Fatalf("Event ID prefix = %q, want %q", got, want)
	}
	sequence, err := ParseResumePosition(eventID, collectionID)
	if err != nil || sequence != 10 {
		t.Fatalf("parse Event ID = %d, %v; want 10, nil", sequence, err)
	}
	if _, err := EventID(collectionID, 0); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("Event ID at zero sequence error = %v, want invalid cursor", err)
	}

	zeroCursor, err := Cursor(collectionID, 0)
	if err != nil {
		t.Fatalf("create zero Cursor: %v", err)
	}
	if sequence, err := ParseResumePosition(zeroCursor, collectionID); err != nil || sequence != 0 {
		t.Fatalf("parse zero Cursor = %d, %v; want 0, nil", sequence, err)
	}
	if sequence, err := ParseResumePosition(mustEventID(t, collectionID, 20), collectionID); err != nil || sequence != 20 {
		t.Fatalf("parse Event ID ending in zero = %d, %v; want 20, nil", sequence, err)
	}
}

func TestParseResumePositionRejectsWrongScopeAndMalformedTokens(t *testing.T) {
	collectionID := "col_abc_def"
	otherCollectionID := "col_other"
	valid, err := Cursor(collectionID, 7)
	if err != nil {
		t.Fatal(err)
	}
	wrongScope, err := Cursor(otherCollectionID, 7)
	if err != nil {
		t.Fatal(err)
	}
	zeroEventID := "evt_" + valid[len("cur_"):len(valid)-20] + "00000000000000000000"
	invalid := []string{
		"",
		valid + "=",
		wrongScope,
		zeroEventID,
		"cur_%%%_00000000000000000007",
		"cur_" + valid[len("cur_"):len(valid)-20] + "0000000000000000000x",
		"evt_" + valid[len("cur_"):len(valid)-20] + "00000000000000000000",
	}
	for _, token := range invalid {
		t.Run(token, func(t *testing.T) {
			if _, err := ParseResumePosition(token, collectionID); !errors.Is(err, ErrInvalidCursor) {
				t.Fatalf("ParseResumePosition(%q) error = %v, want invalid cursor", token, err)
			}
		})
	}
}

func TestAppendIsAtomicAndNotificationFollowsCommit(t *testing.T) {
	store, service := openService(t)
	collectionID := "col_test"
	subscription, err := service.Subscribe(collectionID)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer subscription.Close()
	mutation := Mutation{
		CollectionID: collectionID, RecordID: "rec_1", Type: Created,
		OccurredAt: time.Date(2026, 9, 25, 8, 30, 0, 0, time.UTC), SchemaVersion: 3,
		After: map[string]any{"id": "rec_1", "title": "Hello"},
	}
	rollback := errors.New("rollback")
	if err := store.WithTransaction(context.Background(), func(tx storage.Executor) error {
		if err := service.AppendInTransaction(context.Background(), tx, mutation); err != nil {
			return err
		}
		return rollback
	}); !errors.Is(err, rollback) {
		t.Fatalf("rolled-back transaction error = %v, want rollback", err)
	}
	position, err := service.State(context.Background(), collectionID)
	if err != nil || position.Head != 0 {
		t.Fatalf("state after rollback = %+v, %v; want empty", position, err)
	}
	select {
	case <-subscription.Wake():
		t.Fatal("rolled-back Event notified the subscriber")
	default:
	}

	if err := store.WithTransaction(context.Background(), func(tx storage.Executor) error {
		return service.AppendInTransaction(context.Background(), tx, mutation)
	}); err != nil {
		t.Fatalf("commit Event: %v", err)
	}
	select {
	case <-subscription.Wake():
		t.Fatal("AppendInTransaction notified before caller committed")
	default:
	}
	service.PublishCommitted(collectionID)
	select {
	case <-subscription.Wake():
	default:
		t.Fatal("committed notification was not delivered")
	}

	position, err = service.State(context.Background(), collectionID)
	if err != nil || position.Head != 1 {
		t.Fatalf("state after commit = %+v, %v; want sequence 1", position, err)
	}
	events, err := service.ReadAfter(context.Background(), collectionID, 0, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("read committed Event = %d events, %v; want one", len(events), err)
	}
	if events[0].ID != mustEventID(t, collectionID, 1) || events[0].After["title"] != "Hello" {
		t.Fatalf("persisted Event = %+v", events[0])
	}
}

func TestAppendEventReturnsCommittedEventIdentity(t *testing.T) {
	store, service := openService(t)
	mutation := Mutation{
		CollectionID: "col_returned", RecordID: "rec_returned", Type: Created,
		OccurredAt: time.Date(2026, 9, 25, 9, 0, 0, 0, time.UTC), SchemaVersion: 2,
		After: map[string]any{"id": "rec_returned", "title": "returned"},
	}
	var appended Event
	if err := store.WithTransaction(context.Background(), func(tx storage.Executor) error {
		var err error
		appended, err = service.AppendEventInTransaction(context.Background(), tx, mutation)
		return err
	}); err != nil {
		t.Fatalf("append Event: %v", err)
	}
	if appended.ID != mustEventID(t, mutation.CollectionID, 1) || appended.Sequence != 1 || appended.After["title"] != "returned" {
		t.Fatalf("AppendEventInTransaction() = %+v", appended)
	}
	stored, err := service.ReadAfter(context.Background(), mutation.CollectionID, 0, 1)
	if err != nil || len(stored) != 1 || stored[0].ID != appended.ID {
		t.Fatalf("stored Event = %+v, %v; want returned identity", stored, err)
	}
}

func TestSequenceIsCollectionScopedAndRetentionKeepsRecoveryWatermark(t *testing.T) {
	store, service := openService(t)
	service.retentionEventLimit = 2
	firstCollection := "col_one"
	secondCollection := "col_two"
	for _, collectionID := range []string{firstCollection, secondCollection, firstCollection} {
		mutation := Mutation{
			CollectionID: collectionID, RecordID: "rec_1", Type: Created,
			OccurredAt: time.Now().UTC(), SchemaVersion: 1,
			After: map[string]any{"id": "rec_1"},
		}
		if err := store.WithTransaction(context.Background(), func(tx storage.Executor) error {
			return service.AppendInTransaction(context.Background(), tx, mutation)
		}); err != nil {
			t.Fatalf("append to %s: %v", collectionID, err)
		}
	}
	first, err := service.State(context.Background(), firstCollection)
	if err != nil || first.Head != 2 || !first.HasWatermark || first.Watermark != 1 {
		t.Fatalf("first Collection state = %+v, %v; want head 2 and watermark 1", first, err)
	}
	second, err := service.State(context.Background(), secondCollection)
	if err != nil || second.Head != 1 || second.HasWatermark {
		t.Fatalf("second Collection state = %+v, %v; want head 1 without a watermark", second, err)
	}
	if _, err := service.ReadAfter(context.Background(), firstCollection, 0, 10); !errors.Is(err, ErrCursorExpired) {
		t.Fatalf("read before the retention watermark error = %v, want expired cursor", err)
	}
	events, err := service.ReadAfter(context.Background(), firstCollection, 1, 10)
	if err != nil || len(events) != 1 || events[0].Sequence != 2 {
		t.Fatalf("read after watermark = %+v, %v; want sequence 2", events, err)
	}
}

func TestReplayPageAndSingleEventHaveByteBounds(t *testing.T) {
	store, service := openService(t)
	collectionID := "col_page_bound"
	for index := 0; index < 2; index++ {
		mutation := Mutation{
			CollectionID: collectionID, RecordID: "rec_" + strconv.Itoa(index), Type: Created,
			OccurredAt: time.Now().UTC(), SchemaVersion: 1,
			After: map[string]any{"id": "rec_" + strconv.Itoa(index), "body": strings.Repeat("x", 600<<10)},
		}
		if err := store.WithTransaction(context.Background(), func(tx storage.Executor) error {
			return service.AppendInTransaction(context.Background(), tx, mutation)
		}); err != nil {
			t.Fatalf("append Event %d: %v", index+1, err)
		}
	}
	page, err := service.ReadAfter(context.Background(), collectionID, 0, maximumReadBatch)
	if err != nil || len(page) != 1 || page[0].Sequence != 1 {
		t.Fatalf("first replay page = %d events, %v; want one Event within the byte budget", len(page), err)
	}
	page, err = service.ReadAfter(context.Background(), collectionID, page[0].Sequence, maximumReadBatch)
	if err != nil || len(page) != 1 || page[0].Sequence != 2 {
		t.Fatalf("second replay page = %d events, %v; want sequence 2", len(page), err)
	}

	tooLarge := Mutation{
		CollectionID: collectionID, RecordID: "rec_too_large", Type: Created,
		OccurredAt: time.Now().UTC(), SchemaVersion: 1,
		After: map[string]any{"id": "rec_too_large", "body": strings.Repeat("x", maximumSingleEventBytes)},
	}
	if err := store.WithTransaction(context.Background(), func(tx storage.Executor) error {
		return service.AppendInTransaction(context.Background(), tx, tooLarge)
	}); !errors.Is(err, ErrEventTooLarge) {
		t.Fatalf("oversized Event transaction error = %v, want Event size limit", err)
	}
	position, err := service.State(context.Background(), collectionID)
	if err != nil || position.Head != 2 {
		t.Fatalf("state after oversized Event = %+v, %v; want unchanged sequence head 2", position, err)
	}
}

func TestSubscriptionCapacityAndRuntimeClose(t *testing.T) {
	_, service := openService(t)
	service.maximumConnections = 1
	first, err := service.Subscribe("col_one")
	if err != nil {
		t.Fatalf("first subscription: %v", err)
	}
	if _, err := service.Subscribe("col_two"); !errors.Is(err, ErrCapacityReached) {
		t.Fatalf("over-capacity subscription error = %v", err)
	}
	service.Close()
	select {
	case <-first.Context().Done():
	default:
		t.Fatal("Runtime close did not cancel live subscription")
	}
	if _, err := service.Subscribe("col_one"); !errors.Is(err, ErrServiceClosed) {
		t.Fatalf("subscription after Runtime close error = %v", err)
	}
	first.Close()
}

func mustEventID(t *testing.T, collectionID string, sequence int64) string {
	t.Helper()
	id, err := EventID(collectionID, sequence)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
