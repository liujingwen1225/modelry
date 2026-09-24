package realtimeapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/requests"
)

const (
	heartbeatInterval  = 15 * time.Second
	writeDeadline      = 5 * time.Second
	readBatchSize      = 256
	capacityRetrySecs  = 5
	maximumReplayPages = 8
)

type Module struct {
	models      *backendmodel.Service
	events      *recordevents.Service
	rules       authorization.Evaluator
	sessions    authorization.SessionAuthenticator
	replaySlots chan struct{}
}

func NewModule(models *backendmodel.Service, events *recordevents.Service, rules authorization.Evaluator, sessions authorization.SessionAuthenticator) *Module {
	return &Module{models: models, events: events, rules: rules, sessions: sessions, replaySlots: make(chan struct{}, maximumReplayPages)}
}

func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/{collectionName}/events", module.handleSubscribe)
}

func (module *Module) handleSubscribe(w http.ResponseWriter, request *http.Request) {
	// ServeMux treats a GET pattern as matching HEAD. Reject it before consuming
	// a subscription slot because net/http suppresses HEAD response bodies.
	if request.Method != http.MethodGet {
		writeError(w, request, http.StatusNotFound, "NOT_FOUND", "The requested API endpoint was not found.", "")
		return
	}
	principal, token, err := module.authenticate(request)
	if err != nil {
		requests.MarkAuthentication(request.Context(), requests.AuthenticationRejected)
		writeError(w, request, http.StatusUnauthorized, "UNAUTHENTICATED", "The supplied Application Session is invalid.", "")
		return
	}
	if token == "" {
		requests.MarkAuthentication(request.Context(), requests.AuthenticationAnonymous)
	} else {
		requests.MarkAuthentication(request.Context(), requests.AuthenticationAuthenticated)
	}
	collection, err := module.resolveCollection(request.Context(), request.PathValue("collectionName"))
	if err != nil {
		if errors.Is(err, backendmodel.ErrNotFound) {
			writeError(w, request, http.StatusNotFound, "NOT_FOUND", "The requested Collection was not found.", "")
		} else {
			writeError(w, request, http.StatusServiceUnavailable, "STORAGE_UNAVAILABLE", "The requested Collection could not be loaded.", "Check the project storage and retry.")
		}
		return
	}
	requests.MarkCollection(request.Context(), collection.ID)
	if allowed, evaluationErr := module.collectionAllowed(request.Context(), collection.ID, principal); evaluationErr != nil {
		requests.MarkAuthorization(request.Context(), requests.AuthorizationEvaluationError)
		writeError(w, request, http.StatusServiceUnavailable, "ACCESS_RULE_UNAVAILABLE", "The Applied List Access Rule could not be evaluated.", "Retry after Access Rules are available.")
		return
	} else if !allowed {
		requests.MarkAuthorization(request.Context(), requests.AuthorizationDenied)
		writeError(w, request, http.StatusForbidden, "FORBIDDEN", "The Applied List Access Rule denied this subscription.", "")
		return
	}
	requests.MarkAuthorization(request.Context(), requests.AuthorizationAllowed)
	if module.events == nil || module.models == nil || module.rules == nil {
		writeError(w, request, http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "Realtime subscriptions are not available.", "Retry after the Runtime is ready.")
		return
	}
	resumeValues := request.Header.Values("Last-Event-ID")
	if len(resumeValues) > 1 {
		writeError(w, request, http.StatusBadRequest, "EVENT_CURSOR_INVALID", "The Last-Event-ID header is invalid.", "Open a new stream without a cursor and reload current Records.")
		return
	}
	var requestedSequence int64
	resuming := len(resumeValues) == 1
	if resuming {
		if resumeValues[0] != strings.TrimSpace(resumeValues[0]) {
			writeError(w, request, http.StatusBadRequest, "EVENT_CURSOR_INVALID", "The Last-Event-ID header is invalid for this Collection.", "Open a new stream without a cursor and reload current Records.")
			return
		}
		requestedSequence, err = recordevents.ParseResumePosition(resumeValues[0], collection.ID)
		if err != nil {
			writeError(w, request, http.StatusBadRequest, "EVENT_CURSOR_INVALID", "The Last-Event-ID header is invalid for this Collection.", "Open a new stream without a cursor and reload current Records.")
			return
		}
	}
	subscription, err := module.events.Subscribe(collection.ID)
	if errors.Is(err, recordevents.ErrCapacityReached) {
		w.Header().Set("Retry-After", strconv.Itoa(capacityRetrySecs))
		writeError(w, request, http.StatusTooManyRequests, "STREAM_CAPACITY_REACHED", "The Runtime has reached its active Realtime subscription limit.", "Retry after five seconds.")
		return
	}
	if err != nil {
		writeError(w, request, http.StatusServiceUnavailable, "RUNTIME_NOT_READY", "Realtime subscriptions are not available.", "Retry after the Runtime is ready.")
		return
	}
	defer subscription.Close()
	position, err := module.events.State(request.Context(), collection.ID)
	if err != nil {
		writeError(w, request, http.StatusServiceUnavailable, "STORAGE_UNAVAILABLE", "Realtime Event storage is unavailable.", "Check the project storage and retry.")
		return
	}
	scanSequence := requestedSequence
	if resuming {
		if requestedSequence > position.Head {
			writeError(w, request, http.StatusBadRequest, "EVENT_CURSOR_INVALID", "The Last-Event-ID is ahead of the current Collection Event sequence.", "Open a new stream without a cursor and reload current Records.")
			return
		}
		if position.HasWatermark && requestedSequence < position.Watermark {
			writeError(w, request, http.StatusGone, "EVENT_CURSOR_EXPIRED", "The requested Event cursor is outside the retained recovery window.", "Open a new stream without a cursor, wait for stream.ready, and reload current Records.")
			return
		}
	} else {
		scanSequence = position.Head
	}
	if allowed, evaluationErr := module.collectionAllowed(request.Context(), collection.ID, principal); evaluationErr != nil {
		requests.MarkAuthorization(request.Context(), requests.AuthorizationEvaluationError)
		writeError(w, request, http.StatusServiceUnavailable, "ACCESS_RULE_UNAVAILABLE", "The Applied List Access Rule could not be evaluated.", "Retry after Access Rules are available.")
		return
	} else if !allowed {
		requests.MarkAuthorization(request.Context(), requests.AuthorizationDenied)
		writeError(w, request, http.StatusForbidden, "FORBIDDEN", "The Applied List Access Rule denied this subscription.", "")
		return
	}
	if !httpapi.SupportsResponseControllerFlush(w) {
		writeError(w, request, http.StatusServiceUnavailable, "STREAM_UNAVAILABLE", "The HTTP server cannot flush Realtime frames.", "Retry with a Runtime HTTP server that supports streaming responses.")
		return
	}
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Time{}); err != nil {
		writeError(w, request, http.StatusServiceUnavailable, "STREAM_UNAVAILABLE", "The HTTP server cannot bound Realtime frame writes.", "Retry with a Runtime HTTP server that supports streaming response deadlines.")
		return
	}
	requests.PersistBeforeResponse(request.Context(), http.StatusOK, "")
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	if !resuming {
		cursor, cursorErr := recordevents.Cursor(collection.ID, position.Head)
		if cursorErr != nil || !writeFrame(w, controller, "stream.ready", cursor, map[string]any{"cursor": cursor, "collectionId": collection.ID}) {
			return
		}
	} else if !writeComment(w, controller, ": connected\n\n") {
		return
	}
	module.streamEvents(request.Context(), subscription, w, controller, collection.ID, token, principal, scanSequence)
}

func (module *Module) streamEvents(ctx context.Context, subscription *recordevents.Subscription, w http.ResponseWriter, controller *http.ResponseController, collectionID, token string, principal authorization.Principal, scanSequence int64) {
	heartbeats := time.NewTicker(heartbeatInterval)
	defer heartbeats.Stop()
	for {
		position, err := module.events.State(ctx, collectionID)
		if err != nil || position.HasWatermark && scanSequence < position.Watermark {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-subscription.Context().Done():
			return
		case module.replaySlots <- struct{}{}:
		}
		events, err := module.events.ReadAfter(ctx, collectionID, scanSequence, readBatchSize)
		if err != nil {
			<-module.replaySlots
			return
		}
		if len(events) > 0 {
			continueStreaming := func() bool {
				defer func() { <-module.replaySlots }()
				for _, event := range events {
					scanSequence = event.Sequence
					currentPrincipal, valid := module.revalidate(ctx, token, principal)
					if !valid {
						return false
					}
					if !module.collectionAllowedAfterOpen(ctx, collectionID, currentPrincipal) {
						return false
					}
					name, payload, deliver, evaluationError := module.visibleEvent(ctx, event, currentPrincipal)
					if evaluationError != nil {
						return false
					}
					if !deliver {
						continue
					}
					if !writeFrame(w, controller, name, event.ID, payload) {
						return false
					}
				}
				return true
			}()
			if !continueStreaming {
				return
			}
			continue
		}
		<-module.replaySlots
		select {
		case <-ctx.Done():
			return
		case <-subscription.Context().Done():
			return
		case <-subscription.Wake():
		case <-heartbeats.C:
			currentPrincipal, valid := module.revalidate(ctx, token, principal)
			if !valid || !module.collectionAllowedAfterOpen(ctx, collectionID, currentPrincipal) {
				return
			}
			if !writeComment(w, controller, ": heartbeat\n\n") {
				return
			}
		}
	}
}

func writeFrame(w http.ResponseWriter, controller *http.ResponseController, name, id string, payload any) bool {
	data, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	frame := "event: " + name + "\nid: " + id + "\ndata: " + string(data) + "\n\n"
	return writeStreamData(w, controller, []byte(frame))
}

func writeComment(w http.ResponseWriter, controller *http.ResponseController, comment string) bool {
	return writeStreamData(w, controller, []byte(comment))
}

func writeStreamData(w http.ResponseWriter, controller *http.ResponseController, data []byte) bool {
	if err := controller.SetWriteDeadline(time.Now().Add(writeDeadline)); err != nil {
		return false
	}
	written, err := w.Write(data)
	if err != nil || written != len(data) {
		return false
	}
	if err := controller.Flush(); err != nil {
		return false
	}
	return controller.SetWriteDeadline(time.Time{}) == nil
}

func (module *Module) visibleEvent(ctx context.Context, event recordevents.Event, principal authorization.Principal) (string, any, bool, error) {
	var beforeAllowed, afterAllowed bool
	var err error
	if event.Before != nil {
		beforeAllowed, err = module.recordAllowed(ctx, event.CollectionID, event.RecordID, event.Before, principal)
		if err != nil {
			return "", nil, false, err
		}
	}
	if event.After != nil {
		afterAllowed, err = module.recordAllowed(ctx, event.CollectionID, event.RecordID, event.After, principal)
		if err != nil {
			return "", nil, false, err
		}
	}
	payload := map[string]any{
		"eventId":       event.ID,
		"collectionId":  event.CollectionID,
		"recordId":      event.RecordID,
		"occurredAt":    event.OccurredAt.UTC().Format(time.RFC3339Nano),
		"schemaVersion": event.SchemaVersion,
	}
	switch event.Type {
	case recordevents.Created:
		if !afterAllowed {
			return "", nil, false, nil
		}
		payload["record"] = event.After
		return string(recordevents.Created), payload, true, nil
	case recordevents.Updated:
		if afterAllowed {
			payload["record"] = event.After
			return string(recordevents.Updated), payload, true, nil
		}
		if beforeAllowed {
			return "record.removed", payload, true, nil
		}
		return "", nil, false, nil
	case recordevents.Deleted:
		if !beforeAllowed {
			return "", nil, false, nil
		}
		return string(recordevents.Deleted), payload, true, nil
	default:
		return "", nil, false, errors.New("unsupported retained Record Event type")
	}
}

func (module *Module) recordAllowed(ctx context.Context, collectionID, recordID string, values map[string]any, principal authorization.Principal) (bool, error) {
	decision, err := module.rules.Evaluate(ctx, collectionID, authorization.OperationList, principal, &authorization.Record{ID: recordID, Values: values})
	if err != nil {
		return false, err
	}
	return decision.Allowed, nil
}

func (module *Module) collectionAllowed(ctx context.Context, collectionID string, principal authorization.Principal) (bool, error) {
	if module.rules == nil {
		return false, errors.New("Applied Access Rule evaluator is unavailable")
	}
	decision, err := module.rules.Evaluate(ctx, collectionID, authorization.OperationList, principal, nil)
	if err != nil {
		return false, err
	}
	return decision.Allowed, nil
}

func (module *Module) collectionAllowedAfterOpen(ctx context.Context, collectionID string, principal authorization.Principal) bool {
	allowed, err := module.collectionAllowed(ctx, collectionID, principal)
	return err == nil && allowed
}

func (module *Module) revalidate(ctx context.Context, token string, previous authorization.Principal) (authorization.Principal, bool) {
	if token == "" {
		return previous, true
	}
	if module.sessions == nil {
		return authorization.Principal{}, false
	}
	principal, err := module.sessions.AuthenticateSession(ctx, token)
	if err != nil || principal.Type != previous.Type || principal.ID != previous.ID {
		return authorization.Principal{}, false
	}
	return principal, true
}

func (module *Module) authenticate(request *http.Request) (authorization.Principal, string, error) {
	values := request.Header.Values("Authorization")
	if len(values) == 0 {
		return authorization.Principal{Type: authorization.PrincipalAnonymous}, "", nil
	}
	if len(values) != 1 {
		return authorization.Principal{}, "", errors.New("multiple Application Authorization headers")
	}
	parts := strings.Fields(strings.TrimSpace(values[0]))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || len(parts[1]) > 4096 || module.sessions == nil {
		return authorization.Principal{}, "", errors.New("invalid Application Bearer credential")
	}
	principal, err := module.sessions.AuthenticateSession(request.Context(), parts[1])
	if err != nil || principal.Type != authorization.PrincipalApplication || principal.ID == "" {
		return authorization.Principal{}, "", errors.New("invalid Application Session")
	}
	return principal, parts[1], nil
}

func (module *Module) resolveCollection(ctx context.Context, name string) (backendmodel.Collection, error) {
	if module.models == nil || name == "" || len(name) > 80 {
		return backendmodel.Collection{}, backendmodel.ErrNotFound
	}
	options := backendmodel.ListOptions{Limit: 100}
	for {
		page, err := module.models.ListCollections(ctx, options)
		if err != nil {
			return backendmodel.Collection{}, err
		}
		for _, collection := range page.Data {
			if strings.EqualFold(collection.Name, name) {
				if _, err := module.models.GetRecordProjection(ctx, collection.ID); err != nil {
					return backendmodel.Collection{}, err
				}
				return collection, nil
			}
		}
		if page.NextCursor == "" {
			return backendmodel.Collection{}, backendmodel.ErrNotFound
		}
		options.Cursor = page.NextCursor
	}
}

func writeError(w http.ResponseWriter, request *http.Request, status int, code, message, hint string) {
	httpapi.WriteAPIError(w, request, status, httpapi.APIError{Code: code, Message: message, Hint: hint})
}
