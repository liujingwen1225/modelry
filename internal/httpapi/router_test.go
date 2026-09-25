package httpapi

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type apiWriterTestModule func(*http.ServeMux)

func (module apiWriterTestModule) RegisterRoutes(mux *http.ServeMux) {
	module(mux)
}

type apiWriterTestResponseWriter struct {
	header   http.Header
	status   int
	body     bytes.Buffer
	flushes  int
	deadline time.Time
	flushErr error
}

func newAPIWriterTestResponseWriter() *apiWriterTestResponseWriter {
	return &apiWriterTestResponseWriter{header: make(http.Header)}
}

func (writer *apiWriterTestResponseWriter) Header() http.Header {
	return writer.header
}

func (writer *apiWriterTestResponseWriter) WriteHeader(status int) {
	if writer.status == 0 {
		writer.status = status
	}
}

func (writer *apiWriterTestResponseWriter) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	return writer.body.Write(body)
}

func (writer *apiWriterTestResponseWriter) Flush() {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	writer.flushes++
}

func (writer *apiWriterTestResponseWriter) FlushError() error {
	writer.Flush()
	return writer.flushErr
}

func (writer *apiWriterTestResponseWriter) SetWriteDeadline(deadline time.Time) error {
	writer.deadline = deadline
	return nil
}

type apiWriterTestUnwrapper struct {
	http.ResponseWriter
}

func (writer *apiWriterTestUnwrapper) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func TestAPIRouterFlushForwardsToDownstreamFlusher(t *testing.T) {
	downstream := newAPIWriterTestResponseWriter()
	handler := NewAPIRouter(apiWriterTestModule(func(mux *http.ServeMux) {
		mux.HandleFunc("GET /api/v1/stream", func(w http.ResponseWriter, _ *http.Request) {
			flusher, ok := w.(http.Flusher)
			if !ok {
				t.Error("API writer does not implement http.Flusher")
				return
			}
			flusher.Flush()
		})
	}))

	handler.ServeHTTP(downstream, httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil))
	if downstream.status != http.StatusOK || downstream.flushes != 1 {
		t.Fatalf("downstream status/flushes = %d/%d, want 200/1", downstream.status, downstream.flushes)
	}
}

func TestAPIRouterPreservesResponseControllerUnwrapCapabilities(t *testing.T) {
	downstream := newAPIWriterTestResponseWriter()
	wrapped := &apiWriterTestUnwrapper{ResponseWriter: downstream}
	deadline := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	handler := NewAPIRouter(apiWriterTestModule(func(mux *http.ServeMux) {
		mux.HandleFunc("GET /api/v1/stream", func(w http.ResponseWriter, request *http.Request) {
			controller := http.NewResponseController(w)
			if err := controller.SetWriteDeadline(deadline); err != nil {
				t.Errorf("SetWriteDeadline() error = %v", err)
				return
			}
			if err := controller.Flush(); err != nil {
				t.Errorf("Flush() error = %v", err)
			}
		})
	}))

	handler.ServeHTTP(wrapped, httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil))
	if !downstream.deadline.Equal(deadline) {
		t.Fatalf("downstream deadline = %v, want %v", downstream.deadline, deadline)
	}
	if downstream.status != http.StatusOK || downstream.flushes != 1 {
		t.Fatalf("downstream status/flushes = %d/%d, want 200/1", downstream.status, downstream.flushes)
	}
}

func TestAPIRouterPropagatesFlushError(t *testing.T) {
	wantErr := errors.New("flush failed")
	downstream := newAPIWriterTestResponseWriter()
	downstream.flushErr = wantErr
	var gotErr error
	handler := NewAPIRouter(apiWriterTestModule(func(mux *http.ServeMux) {
		mux.HandleFunc("GET /api/v1/stream", func(w http.ResponseWriter, request *http.Request) {
			gotErr = http.NewResponseController(w).Flush()
		})
	}))

	handler.ServeHTTP(downstream, httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil))
	if !errors.Is(gotErr, wantErr) {
		t.Fatalf("Flush() error = %v, want %v", gotErr, wantErr)
	}
}

func TestAPIRouterMethodErrorFlushDoesNotCommitSuccess(t *testing.T) {
	downstream := newAPIWriterTestResponseWriter()
	handler := NewAPIRouter(apiWriterTestModule(func(mux *http.ServeMux) {
		mux.HandleFunc("GET /api/v1/rejected", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusMethodNotAllowed)
			w.(http.Flusher).Flush()
			_, _ = w.Write([]byte("method error"))
		})
	}))

	handler.ServeHTTP(downstream, httptest.NewRequest(http.MethodGet, "/api/v1/rejected", nil))
	if downstream.status != http.StatusNotFound || downstream.flushes != 0 {
		t.Fatalf("downstream status/flushes = %d/%d, want structured 404 and no flush", downstream.status, downstream.flushes)
	}
	if bytes.Contains(downstream.body.Bytes(), []byte("method error")) {
		t.Fatalf("method error body escaped route wrapper: %s", downstream.body.String())
	}
}
