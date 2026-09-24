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
