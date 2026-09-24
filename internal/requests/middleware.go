package requests

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/liujingwen1225/modelry/internal/httpapi"
)

const (
	PersistedHeader     = "X-Request-Record-Persisted"
	maximumBufferedJSON = 1 << 20
	recordWriteTimeout  = 2 * time.Second
)

type metadataKey struct{}

type requestMetadata struct {
	mu             sync.Mutex
	collectionID   string
	authentication string
	authorization  string
	persistBefore  func(int, string) bool
}

// MarkCollection 将已解析的 Collection ID 放入当前请求的安全遥测元数据。
func MarkCollection(ctx context.Context, collectionID string) {
	metadata, ok := ctx.Value(metadataKey{}).(*requestMetadata)
	if !ok || len(collectionID) > 128 || containsQueryOrFragment(collectionID) {
		return
	}
	metadata.mu.Lock()
	metadata.collectionID = collectionID
	metadata.mu.Unlock()
}

// MarkAuthentication 仅接收有限的认证结果枚举，不接收任何凭据或 Header 内容。
func MarkAuthentication(ctx context.Context, outcome string) {
	metadata, ok := ctx.Value(metadataKey{}).(*requestMetadata)
	if !ok || !validAuthenticationOutcome(outcome) {
		return
	}
	metadata.mu.Lock()
	metadata.authentication = outcome
	metadata.mu.Unlock()
}

// MarkAuthorization 仅接收有限的授权结果枚举，不接收规则正文或业务数据。
func MarkAuthorization(ctx context.Context, outcome string) {
	metadata, ok := ctx.Value(metadataKey{}).(*requestMetadata)
	if !ok || !validAuthorizationOutcome(outcome) {
		return
	}
	metadata.mu.Lock()
	metadata.authorization = outcome
	metadata.mu.Unlock()
}

// PersistBeforeResponse 在流式响应提交 Header 前先写入 RequestRecord，供下载设置真实 Header 而不是 Trailer。
func PersistBeforeResponse(ctx context.Context, status int, errorCode string) bool {
	metadata, ok := ctx.Value(metadataKey{}).(*requestMetadata)
	if !ok {
		return false
	}
	metadata.mu.Lock()
	persist := metadata.persistBefore
	metadata.mu.Unlock()
	if persist == nil {
		return false
	}
	return persist(status, errorCode)
}

// Middleware 记录所有 Application API 请求；它只保存安全路径、有限 outcome 和响应字节数，不读取请求 Body、Header 或 Query。
func (service *Service) Middleware(next http.Handler) http.Handler {
	if next == nil {
		next = http.NotFoundHandler()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if !isApplicationPath(request.URL.Path) {
			next.ServeHTTP(w, request)
			return
		}

		metadata := &requestMetadata{authentication: AuthenticationUnknown, authorization: AuthorizationNotEvaluated}
		request = request.WithContext(context.WithValue(request.Context(), metadataKey{}, metadata))
		path := safeEndpoint(request.URL.Path)
		method := strings.ToUpper(strings.TrimSpace(request.Method))
		if !methodPattern.MatchString(method) {
			method = "OTHER"
		}
		startedAt := service.now().UTC()
		writer := &recordResponseWriter{
			ResponseWriter: w,
			service:        service,
			request:        request,
			metadata:       metadata,
			startedAt:      startedAt,
			record: RequestRecord{
				RequestID:             httpapi.RequestID(request.Context()),
				Time:                  startedAt,
				Endpoint:              path,
				Method:                method,
				AuthenticationOutcome: AuthenticationUnknown,
				AuthorizationOutcome:  AuthorizationNotEvaluated,
			},
		}
		metadata.persistBefore = writer.persistBeforeResponse
		next.ServeHTTP(writer, request)
		writer.finish()
	})
}

func isApplicationPath(path string) bool {
	return path == "/api/v1" || strings.HasPrefix(path, "/api/v1/")
}

// safeEndpoint 保存路由模板，不持久化调用方提供的动态路径段。
// Collection、Record、字段和 Session ID 都是路由参数，不能进入耐久遥测。
func safeEndpoint(path string) string {
	if path == "/api/v1" {
		return path
	}
	const prefix = "/api/v1/"
	if !strings.HasPrefix(path, prefix) {
		return "/api/v1/{unmatched}"
	}
	segments := strings.Split(strings.TrimPrefix(path, prefix), "/")
	for _, segment := range segments {
		if segment == "" {
			return "/api/v1/{unmatched}"
		}
	}

	if segments[0] == "auth" {
		if len(segments) == 3 {
			switch segments[2] {
			case "register", "login", "session", "logout", "password", "sessions":
				return "/api/v1/auth/{collectionName}/" + segments[2]
			}
		}
		if len(segments) == 5 && segments[2] == "sessions" && segments[4] == "revoke" {
			return "/api/v1/auth/{collectionName}/sessions/{sessionId}/revoke"
		}
		return "/api/v1/{unmatched}"
	}

	switch len(segments) {
	case 1:
		return "/api/v1/{collectionName}"
	case 2:
		if segments[1] == "events" {
			return "/api/v1/{collectionName}/events"
		}
		return "/api/v1/{collectionName}/{recordId}"
	case 4:
		if segments[2] == "files" {
			return "/api/v1/{collectionName}/{recordId}/files/{fieldName}"
		}
	}
	return "/api/v1/{unmatched}"
}

type recordResponseWriter struct {
	http.ResponseWriter
	service             *Service
	request             *http.Request
	metadata            *requestMetadata
	startedAt           time.Time
	record              RequestRecord
	status              int
	buffer              bytes.Buffer
	bufferingJSON       bool
	committed           bool
	finished            bool
	responseBytes       int64
	persisted           bool
	persistAttempted    bool
	persistBeforeCommit bool
}

func (writer *recordResponseWriter) WriteHeader(status int) {
	if writer.status != 0 {
		return
	}
	writer.status = status
	if writer.persistBeforeCommit {
		writer.Header().Set(PersistedHeader, writer.persistedValue())
		writer.ResponseWriter.WriteHeader(status)
		writer.committed = true
		return
	}
	contentType := strings.ToLower(writer.Header().Get("Content-Type"))
	if strings.Contains(contentType, "application/json") && status != http.StatusNoContent && status != http.StatusNotModified {
		writer.bufferingJSON = true
		return
	}
	if status == http.StatusNoContent || status == http.StatusNotModified {
		writer.persist(status, "")
		writer.Header().Set(PersistedHeader, writer.persistedValue())
		writer.ResponseWriter.WriteHeader(status)
		writer.committed = true
		return
	}
	writer.beginStreaming()
}

func (writer *recordResponseWriter) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	if writer.bufferingJSON {
		if writer.buffer.Len()+len(body) <= maximumBufferedJSON {
			return writer.buffer.Write(body)
		}
		writer.beginStreaming()
	}
	written, err := writer.ResponseWriter.Write(body)
	writer.responseBytes += int64(written)
	return written, err
}

func (writer *recordResponseWriter) Flush() {
	_ = writer.FlushError()
}

func (writer *recordResponseWriter) FlushError() error {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	if writer.bufferingJSON {
		writer.beginStreaming()
	}
	return http.NewResponseController(writer.ResponseWriter).Flush()
}

func (writer *recordResponseWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func (writer *recordResponseWriter) beginStreaming() {
	if writer.committed {
		return
	}
	writer.bufferingJSON = false
	writer.persistBeforeCommit = true
	writer.persist(writer.status, "")
	writer.Header().Set(PersistedHeader, writer.persistedValue())
	writer.ResponseWriter.WriteHeader(writer.status)
	writer.committed = true
	if writer.buffer.Len() != 0 {
		written, _ := writer.ResponseWriter.Write(writer.buffer.Bytes())
		writer.responseBytes += int64(written)
		writer.buffer.Reset()
	}
}

func (writer *recordResponseWriter) finish() {
	if writer.finished {
		return
	}
	writer.finished = true
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	if writer.bufferingJSON {
		errorCode := ""
		if writer.status >= 400 {
			errorCode = errorCodeFromJSON(writer.buffer.Bytes())
		}
		writer.record.ResponseSizeBytes = responseSize(int64(writer.buffer.Len()))
		writer.persist(writer.status, errorCode)
		writer.Header().Set(PersistedHeader, writer.persistedValue())
		writer.ResponseWriter.WriteHeader(writer.status)
		writer.committed = true
		if writer.buffer.Len() != 0 {
			_, _ = writer.ResponseWriter.Write(writer.buffer.Bytes())
		}
		return
	}
	if writer.persistBeforeCommit {
		writer.updateResponseMetrics()
	}
}

func (writer *recordResponseWriter) persistBeforeResponse(status int, errorCode string) bool {
	if writer.finished || writer.status != 0 || status < 100 || status > 599 {
		return false
	}
	writer.persistBeforeCommit = true
	if size, err := strconv.ParseInt(strings.TrimSpace(writer.Header().Get("Content-Length")), 10, 64); err == nil && size >= 0 {
		writer.record.ResponseSizeBytes = responseSize(size)
	}
	writer.persist(status, errorCode)
	return writer.persisted
}

func (writer *recordResponseWriter) persist(status int, errorCode string) {
	if writer.persistAttempted {
		return
	}
	writer.persistAttempted = true
	metadata := writer.metadata
	metadata.mu.Lock()
	writer.record.CollectionID = metadata.collectionID
	writer.record.AuthenticationOutcome = metadata.authentication
	writer.record.AuthorizationOutcome = metadata.authorization
	metadata.mu.Unlock()
	writer.record.Status = status
	if writer.record.ResponseSizeBytes == nil && !writer.persistBeforeCommit {
		writer.record.ResponseSizeBytes = responseSize(writer.responseBytes)
	}
	writer.record.DurationMS = time.Since(writer.startedAt).Milliseconds()
	if writer.record.DurationMS < 0 {
		writer.record.DurationMS = 0
	}
	if errorCodePattern.MatchString(errorCode) {
		writer.record.ErrorCode = errorCode
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(writer.request.Context()), recordWriteTimeout)
	defer cancel()
	writer.persisted = writer.service.Append(ctx, writer.record) == nil
}

func (writer *recordResponseWriter) updateResponseMetrics() {
	duration := time.Since(writer.startedAt).Milliseconds()
	if duration < 0 {
		duration = 0
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(writer.request.Context()), recordWriteTimeout)
	defer cancel()
	_ = writer.service.UpdateResponseMetrics(ctx, writer.record.RequestID, duration, writer.responseBytes)
}

func responseSize(size int64) *int64 { return &size }

func (writer *recordResponseWriter) persistedValue() string {
	if writer.persisted {
		return "true"
	}
	return "false"
}

func errorCodeFromJSON(body []byte) string {
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return ""
	}
	return envelope.Error.Code
}
