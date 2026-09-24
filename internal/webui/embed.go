package webui

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var embeddedFiles embed.FS

func Validate() error {
	index, err := fs.Stat(embeddedFiles, "dist/index.html")
	if err != nil {
		return fmt.Errorf("Admin UI bundle is missing dist/index.html: %w", err)
	}
	if !index.Mode().IsRegular() || index.Size() == 0 {
		return fmt.Errorf("Admin UI bundle dist/index.html is not a non-empty file")
	}
	return nil
}

func Handler() http.Handler {
	dist, err := fs.Sub(embeddedFiles, "dist")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "Admin assets are unavailable", http.StatusServiceUnavailable)
		})
	}
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		name := strings.TrimPrefix(path.Clean("/"+request.URL.Path), "/")
		if name != "." && fs.ValidPath(name) {
			if info, err := fs.Stat(dist, name); err == nil && !info.IsDir() {
				files.ServeHTTP(w, request)
				return
			}
		}
		clone := request.Clone(request.Context())
		urlCopy := *request.URL
		urlCopy.Path = "/"
		clone.URL = &urlCopy
		files.ServeHTTP(w, clone)
	})
}
