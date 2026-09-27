package httpapi

import "net/http"

// APIModule 将一个领域模块的端点注册到共享 Runtime 路由。
type APIModule interface {
	RegisterRoutes(*http.ServeMux)
}

// NewAPIRouter 汇总控制面和应用面端点，并为未知 API 路径保留统一错误格式。
func NewAPIRouter(modules ...APIModule) http.Handler {
	mux := http.NewServeMux()
	for _, module := range modules {
		if module != nil {
			module.RegisterRoutes(mux)
		}
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		writeError(w, request, http.StatusNotFound, "NOT_FOUND", "The requested API endpoint was not found.", "")
	})
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		writer := &apiMethodWriter{ResponseWriter: w}
		mux.ServeHTTP(writer, request)
		if writer.methodNotAllowed {
			w.Header().Del("Allow")
			writeError(w, request, http.StatusNotFound, "NOT_FOUND", "The requested API endpoint was not found.", "")
		}
	})
}

type apiMethodWriter struct {
	http.ResponseWriter
	methodNotAllowed bool
	wroteHeader      bool
}

// SupportsResponseControllerFlush inspects the final writer behind Modelry's
// streaming wrappers without invoking Flush, which would commit headers.
func SupportsResponseControllerFlush(writer http.ResponseWriter) bool {
	for writer != nil {
		if unwrapper, ok := writer.(interface{ Unwrap() http.ResponseWriter }); ok {
			next := unwrapper.Unwrap()
			if next == nil || next == writer {
				return false
			}
			writer = next
			continue
		}
		if _, ok := writer.(http.Flusher); ok {
			return true
		}
		if _, ok := writer.(interface{ FlushError() error }); ok {
			return true
		}
		return false
	}
	return false
}

func (writer *apiMethodWriter) WriteHeader(status int) {
	if writer.wroteHeader {
		return
	}
	writer.wroteHeader = true
	if status == http.StatusMethodNotAllowed {
		writer.methodNotAllowed = true
		return
	}
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *apiMethodWriter) Write(data []byte) (int, error) {
	if writer.methodNotAllowed {
		return len(data), nil
	}
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.ResponseWriter.Write(data)
}

// Flush 将流式响应刷新到下游；方法错误仍由路由器转换为结构化 404，不能提前提交响应。
func (writer *apiMethodWriter) Flush() {
	_ = writer.FlushError()
}

func (writer *apiMethodWriter) FlushError() error {
	if writer.methodNotAllowed {
		return nil
	}
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}
	return http.NewResponseController(writer.ResponseWriter).Flush()
}

// Unwrap 让 ResponseController 沿下游包装器查找可选的 HTTP 能力。
func (writer *apiMethodWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}
