package realtimeapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/accesscontrol"
	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/requests"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type testSessionAuthenticator struct {
	principal authorization.Principal
	token     string
}

func (authenticator testSessionAuthenticator) AuthenticateSession(_ context.Context, token string) (authorization.Principal, error) {
	if token != authenticator.token {
		return authorization.Principal{}, io.ErrUnexpectedEOF
	}
	return authenticator.principal, nil
}

type testStack struct {
	store    *storage.Store
	models   *backendmodel.Service
	rules    *accesscontrol.Service
	events   *recordevents.Service
	records  *records.Service
	requests *requests.Service
	posts    backendmodel.Collection
}

func newTestStack(t *testing.T) testStack {
	t.Helper()
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatalf("open storage: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close storage: %v", err)
		}
	})
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatalf("initialize Backend Model: %v", err)
	}
	rules, err := accesscontrol.NewService(ctx, store, models)
	if err != nil {
		t.Fatalf("initialize Access Rules: %v", err)
	}
	events, err := recordevents.NewService(ctx, store)
	if err != nil {
		t.Fatalf("initialize Record Events: %v", err)
	}
	recordService, err := records.New(store, models, records.WithAuthorization(rules, nil), records.WithRecordEvents(events))
	if err != nil {
		t.Fatalf("initialize Records: %v", err)
	}
	requestService, err := requests.NewService(ctx, store)
	if err != nil {
		t.Fatalf("initialize Request Records: %v", err)
	}
	posts, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "Posts",
		Type: backendmodel.CollectionTypeNormal,
		Fields: []backendmodel.Field{
			{Name: "title", Type: backendmodel.FieldTypeText, Required: true},
			{Name: "visibility", Type: backendmodel.FieldTypeText, Required: true},
		},
	})
	if err != nil {
		t.Fatalf("create Posts Collection: %v", err)
	}
	return testStack{store: store, models: models, rules: rules, events: events, records: recordService, requests: requestService, posts: posts}
}

func (stack testStack) server(t *testing.T, sessions authorization.SessionAuthenticator) *httptest.Server {
	t.Helper()
	module := NewModule(stack.models, stack.events, stack.rules, sessions)
	router := httpapi.NewAPIRouter(module)
	handler := httpapi.NewHandler(nil, nil, stack.requests.Middleware(router))
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func (stack testStack) applyListRule(t *testing.T, mode accesscontrol.Mode, expression json.RawMessage) {
	t.Helper()
	ctx := context.Background()
	state, err := stack.rules.Get(ctx, stack.posts.ID)
	if err != nil {
		t.Fatalf("get Access Rules: %v", err)
	}
	rules := append([]accesscontrol.Rule(nil), state.Applied...)
	rules[0].Mode = mode
	rules[0].Expression = expression
	pending, err := stack.rules.Save(ctx, stack.posts.ID, accesscontrol.SaveInput{ExpectedVersion: state.Version, Rules: rules})
	if err != nil {
		t.Fatalf("save List Access Rule: %v", err)
	}
	if _, err := stack.rules.Apply(ctx, stack.posts.ID, pending.Version); err != nil {
		t.Fatalf("apply List Access Rule: %v", err)
	}
}

func TestStreamDeliversCommittedAuthorizedEventsAndRemovesNewlyHiddenRecords(t *testing.T) {
	stack := newTestStack(t)
	var visibilityFieldID string
	for _, field := range stack.posts.Fields {
		if field.Name == "visibility" {
			visibilityFieldID = field.ID
		}
	}
	expression, err := json.Marshal(map[string]any{"version": 1, "all": []map[string]any{{"fieldId": visibilityFieldID, "operator": "eq", "value": "public"}}})
	if err != nil {
		t.Fatal(err)
	}
	stack.applyListRule(t, accesscontrol.ModeCustom, expression)
	server := stack.server(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/v1/posts/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept", "text/event-stream")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("open Realtime stream: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" || response.Header.Get(requests.PersistedHeader) != "true" {
		t.Fatalf("stream status/headers = %d, %v", response.StatusCode, response.Header)
	}
	reader := bufio.NewReader(response.Body)
	ready := readSSEFrame(t, reader)
	if !strings.Contains(ready, "event: stream.ready\n") || !strings.Contains(ready, "id: cur_") || !strings.Contains(ready, `"collectionId":"`+stack.posts.ID+`"`) {
		t.Fatalf("initial stream frame = %q", ready)
	}

	hidden, err := stack.records.Create(ctx, stack.posts.ID, map[string]any{"title": "PRIVATE_MARKER", "visibility": "private"})
	if err != nil {
		t.Fatalf("create non-listable Record: %v", err)
	}
	visible, err := stack.records.Create(ctx, stack.posts.ID, map[string]any{"title": "PUBLIC_MARKER", "visibility": "public"})
	if err != nil {
		t.Fatalf("create listable Record: %v", err)
	}
	created := readSSEFrame(t, reader)
	if !strings.Contains(created, "event: record.created\n") || !strings.Contains(created, visible.ID) || !strings.Contains(created, "PUBLIC_MARKER") {
		t.Fatalf("authorized create frame = %q", created)
	}
	if strings.Contains(created, hidden.ID) || strings.Contains(created, "PRIVATE_MARKER") {
		t.Fatalf("authorized stream leaked a hidden Record: %q", created)
	}

	if _, err := stack.records.Update(ctx, stack.posts.ID, visible.ID, map[string]any{"visibility": "private"}); err != nil {
		t.Fatalf("make Record no longer listable: %v", err)
	}
	removed := readSSEFrame(t, reader)
	if !strings.Contains(removed, "event: record.removed\n") || !strings.Contains(removed, visible.ID) || strings.Contains(removed, "PUBLIC_MARKER") || strings.Contains(removed, `"record":{`) {
		t.Fatalf("Record removal frame = %q", removed)
	}
	ruleState, err := stack.rules.Get(ctx, stack.posts.ID)
	if err != nil {
		t.Fatal(err)
	}
	deleteRules := append([]accesscontrol.Rule(nil), ruleState.Applied...)
	for index := range deleteRules {
		if deleteRules[index].Operation == authorization.OperationDelete {
			deleteRules[index].Mode = accesscontrol.ModeAnyone
		}
	}
	deletePending, err := stack.rules.Save(ctx, stack.posts.ID, accesscontrol.SaveInput{ExpectedVersion: ruleState.Version, Rules: deleteRules})
	if err != nil {
		t.Fatalf("allow the test Delete operation: %v", err)
	}
	if _, err := stack.rules.Apply(ctx, stack.posts.ID, deletePending.Version); err != nil {
		t.Fatalf("apply Delete Access Rule: %v", err)
	}
	if err := stack.records.Delete(ctx, stack.posts.ID, hidden.ID); err != nil {
		t.Fatalf("delete hidden Record: %v", err)
	}
	afterHiddenDelete, err := stack.records.Create(ctx, stack.posts.ID, map[string]any{"title": "AFTER_HIDDEN_DELETE_MARKER", "visibility": "public"})
	if err != nil {
		t.Fatalf("create visible Record after hidden Delete: %v", err)
	}
	deleteBoundary := readSSEFrame(t, reader)
	if !strings.Contains(deleteBoundary, "event: record.created\n") || !strings.Contains(deleteBoundary, afterHiddenDelete.ID) || !strings.Contains(deleteBoundary, "AFTER_HIDDEN_DELETE_MARKER") {
		t.Fatalf("visible frame after hidden Delete = %q", deleteBoundary)
	}
	if strings.Contains(deleteBoundary, hidden.ID) || strings.Contains(deleteBoundary, "PRIVATE_MARKER") {
		t.Fatalf("stream leaked an invisible deleted Record ID or value: %q", deleteBoundary)
	}
}

func TestStreamRechecksCurrentListAccessWhenReplayingRetainedEvents(t *testing.T) {
	stack := newTestStack(t)
	stack.applyListRule(t, accesscontrol.ModeAnyone, nil)
	hidden, err := stack.records.Create(context.Background(), stack.posts.ID, map[string]any{"title": "OLD_PRIVATE_MARKER", "visibility": "private"})
	if err != nil {
		t.Fatalf("create Record before Access Rule change: %v", err)
	}
	var visibilityFieldID string
	for _, field := range stack.posts.Fields {
		if field.Name == "visibility" {
			visibilityFieldID = field.ID
		}
	}
	expression, err := json.Marshal(map[string]any{"version": 1, "all": []map[string]any{{"fieldId": visibilityFieldID, "operator": "eq", "value": "public"}}})
	if err != nil {
		t.Fatal(err)
	}
	stack.applyListRule(t, accesscontrol.ModeCustom, expression)
	server := stack.server(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/v1/posts/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept", "text/event-stream")
	zeroCursor, err := recordevents.Cursor(stack.posts.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Last-Event-ID", zeroCursor)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("open resumed Realtime stream: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("resumed stream status = %d", response.StatusCode)
	}
	reader := bufio.NewReader(response.Body)
	if connected := readSSEFrame(t, reader); connected != ": connected" {
		t.Fatalf("resumed stream connection comment = %q", connected)
	}
	visible, err := stack.records.Create(ctx, stack.posts.ID, map[string]any{"title": "CURRENT_PUBLIC_MARKER", "visibility": "public"})
	if err != nil {
		t.Fatalf("create currently visible Record: %v", err)
	}
	frame := readSSEFrame(t, reader)
	if !strings.Contains(frame, "event: record.created\n") || !strings.Contains(frame, visible.ID) || !strings.Contains(frame, "CURRENT_PUBLIC_MARKER") {
		t.Fatalf("currently authorized replay frame = %q", frame)
	}
	if strings.Contains(frame, hidden.ID) || strings.Contains(frame, "OLD_PRIVATE_MARKER") {
		t.Fatalf("replay leaked a Record hidden by the current Access Rule: %q", frame)
	}
}

func TestStreamRejectsInvalidBearerInsteadOfDowngradingToAnonymous(t *testing.T) {
	stack := newTestStack(t)
	stack.applyListRule(t, accesscontrol.ModeAnyone, nil)
	server := stack.server(t, testSessionAuthenticator{
		principal: authorization.Principal{Type: authorization.PrincipalApplication, ID: "app_user_1"},
		token:     "valid-session-token",
	})
	request, err := http.NewRequest(http.MethodGet, server.URL+"/api/v1/posts/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer invalid-session-token")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized || strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("invalid Session response = %d %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.Code != "UNAUTHENTICATED" {
		t.Fatalf("invalid Session error code = %q", envelope.Error.Code)
	}
	requestRecord, err := stack.requests.Get(context.Background(), response.Header.Get("X-Request-Id"))
	if err != nil {
		t.Fatal(err)
	}
	if requestRecord.AuthenticationOutcome != requests.AuthenticationRejected {
		t.Fatalf("invalid Session authentication outcome = %q", requestRecord.AuthenticationOutcome)
	}
	encoded, err := json.Marshal(requestRecord)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "invalid-session-token") || strings.Contains(string(encoded), "valid-session-token") {
		t.Fatalf("RequestRecord leaked an Application Session: %s", encoded)
	}
}

func TestBlockedSSEWriteDoesNotBlockIndependentRecordMutation(t *testing.T) {
	stack := newTestStack(t)
	stack.applyListRule(t, accesscontrol.ModeAnyone, nil)
	module := NewModule(stack.models, stack.events, stack.rules, nil)
	handler := httpapi.NewAPIRouter(module)
	writer := &blockedStreamResponseWriter{
		header:  make(http.Header),
		ready:   make(chan struct{}),
		blocked: make(chan struct{}),
		release: make(chan struct{}),
	}
	var releaseOnce sync.Once
	releaseWriter := func() { releaseOnce.Do(func() { close(writer.release) }) }
	defer releaseWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/posts/events", nil).WithContext(ctx)
	request.Header.Set("Accept", "text/event-stream")
	handlerDone := make(chan struct{})
	go func() {
		handler.ServeHTTP(writer, request)
		close(handlerDone)
	}()
	select {
	case <-writer.ready:
	case <-time.After(2 * time.Second):
		t.Fatal("Realtime stream did not flush its baseline frame")
	}

	mutationDone := make(chan error, 1)
	go func() {
		_, err := stack.records.Create(ctx, stack.posts.ID, map[string]any{"title": "BLOCKED_WRITER_PUBLIC_MARKER", "visibility": "public"})
		mutationDone <- err
	}()
	select {
	case <-writer.blocked:
	case <-time.After(2 * time.Second):
		t.Fatal("Realtime stream did not enter its blocked Event write")
	}
	select {
	case err := <-mutationDone:
		if err != nil {
			t.Fatalf("independent Record mutation failed while SSE write was blocked: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("independent Record mutation waited for the blocked SSE client")
	}
	releaseWriter()
	cancel()
	select {
	case <-handlerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Realtime handler did not release after client cancellation")
	}
}

func TestStreamCursorErrorsAreReportedBeforeSSEHeaders(t *testing.T) {
	stack := newTestStack(t)
	stack.applyListRule(t, accesscontrol.ModeAnyone, nil)
	for index := 0; index < 2; index++ {
		if _, err := stack.records.Create(context.Background(), stack.posts.ID, map[string]any{"title": "Post", "visibility": "public"}); err != nil {
			t.Fatalf("create retained Event %d: %v", index+1, err)
		}
	}
	if err := stack.store.WithTransaction(context.Background(), func(tx storage.Executor) error {
		if _, err := tx.ExecContext(context.Background(), `DELETE FROM modelry_record_events WHERE collection_id = ? AND sequence = 1`, stack.posts.ID); err != nil {
			return err
		}
		_, err := tx.ExecContext(context.Background(), `INSERT INTO modelry_record_event_watermarks (collection_id, pruned_sequence) VALUES (?, 1)`, stack.posts.ID)
		return err
	}); err != nil {
		t.Fatalf("simulate retained Event window: %v", err)
	}
	server := stack.server(t, nil)
	zeroCursor, err := recordevents.Cursor(stack.posts.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	wrongCollectionCursor, err := recordevents.Cursor("col_other", 1)
	if err != nil {
		t.Fatal(err)
	}
	futureCursor, err := recordevents.Cursor(stack.posts.ID, 3)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		cursor     string
		wantStatus int
		wantCode   string
	}{
		{name: "expired", cursor: zeroCursor, wantStatus: http.StatusGone, wantCode: "EVENT_CURSOR_EXPIRED"},
		{name: "wrong Collection", cursor: wrongCollectionCursor, wantStatus: http.StatusBadRequest, wantCode: "EVENT_CURSOR_INVALID"},
		{name: "future", cursor: futureCursor, wantStatus: http.StatusBadRequest, wantCode: "EVENT_CURSOR_INVALID"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodGet, server.URL+"/api/v1/posts/events", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Last-Event-ID", test.cursor)
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != test.wantStatus || envelope.Error.Code != test.wantCode || strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
				t.Fatalf("cursor response = %d %q %q", response.StatusCode, envelope.Error.Code, response.Header.Get("Content-Type"))
			}
		})
	}
	watermarkCursor, err := recordevents.Cursor(stack.posts.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodGet, server.URL+"/api/v1/posts/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Last-Event-ID", watermarkCursor)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("cursor at watermark response status = %d", response.StatusCode)
	}
	reader := bufio.NewReader(response.Body)
	if connected := readSSEFrame(t, reader); connected != ": connected" {
		t.Fatalf("watermark resume connection comment = %q", connected)
	}
	frame := readSSEFrame(t, reader)
	if !strings.Contains(frame, "event: record.created\n") || !strings.Contains(frame, `"eventId":"`+mustEventID(t, stack.posts.ID, 2)+`"`) {
		t.Fatalf("cursor at watermark resumed frame = %q", frame)
	}
}

func TestSubscribeRejectsHEADBeforeOpeningStream(t *testing.T) {
	stack := newTestStack(t)
	module := NewModule(stack.models, stack.events, stack.rules, nil)
	request := httptest.NewRequest(http.MethodHead, "/api/v1/posts/events", nil)
	request.SetPathValue("collectionName", stack.posts.Name)
	response := httptest.NewRecorder()

	module.handleSubscribe(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("HEAD status = %d, want %d", response.Code, http.StatusNotFound)
	}
	if !strings.Contains(response.Body.String(), `"code":"NOT_FOUND"`) {
		t.Fatalf("HEAD should return the structured not found response, got %s", response.Body.String())
	}
}

type deadlineOnlyResponseWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

type blockedStreamResponseWriter struct {
	header  http.Header
	ready   chan struct{}
	blocked chan struct{}
	release chan struct{}
}

func (writer *blockedStreamResponseWriter) Header() http.Header { return writer.header }

func (writer *blockedStreamResponseWriter) WriteHeader(int) {}

func (writer *blockedStreamResponseWriter) Write(body []byte) (int, error) {
	if bytes.Contains(body, []byte("event: stream.ready\n")) {
		close(writer.ready)
	}
	if bytes.Contains(body, []byte("event: record.created\n")) {
		close(writer.blocked)
		<-writer.release
	}
	return len(body), nil
}

func (writer *blockedStreamResponseWriter) FlushError() error { return nil }

func (writer *blockedStreamResponseWriter) SetWriteDeadline(time.Time) error { return nil }

func (writer *deadlineOnlyResponseWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = make(http.Header)
	}
	return writer.header
}

func (writer *deadlineOnlyResponseWriter) WriteHeader(status int) { writer.status = status }

func (writer *deadlineOnlyResponseWriter) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	return writer.body.Write(body)
}

func (writer *deadlineOnlyResponseWriter) SetWriteDeadline(time.Time) error { return nil }

func TestSubscribeChecksUnderlyingFlushCapabilityBeforeSSEHeaders(t *testing.T) {
	stack := newTestStack(t)
	stack.applyListRule(t, accesscontrol.ModeAnyone, nil)
	router := httpapi.NewAPIRouter(NewModule(stack.models, stack.events, stack.rules, nil))
	response := &deadlineOnlyResponseWriter{}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/posts/events", nil)

	router.ServeHTTP(response, request)

	if response.status != http.StatusServiceUnavailable || strings.Contains(response.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("unsupported Flush response = %d %q", response.status, response.Header().Get("Content-Type"))
	}
	if !strings.Contains(response.body.String(), `"code":"STREAM_UNAVAILABLE"`) {
		t.Fatalf("missing structured stream capability error: %s", response.body.String())
	}
}

func readSSEFrame(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	var lines []string
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read SSE frame: %v", err)
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			return strings.Join(lines, "\n")
		}
		lines = append(lines, line)
	}
}

func mustEventID(t *testing.T, collectionID string, sequence int64) string {
	t.Helper()
	id, err := recordevents.EventID(collectionID, sequence)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
