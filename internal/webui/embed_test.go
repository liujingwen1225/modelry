package webui

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEmbeddedAdminBundleSupportsDeepLinks(t *testing.T) {
	if err := Validate(); err != nil {
		t.Fatal(err)
	}
	handler := Handler()
	for _, route := range []string{"/", "/settings", "/collections/posts", "/changes"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", route, nil))
		body, err := io.ReadAll(response.Result().Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.Code != 200 || !strings.Contains(string(body), "<div id=\"root\"") {
			t.Errorf("route %q did not serve the embedded Admin application: status=%d body=%q", route, response.Code, body)
		}
	}
}
