package projectprefs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestProjectPreferencesSaveValidationAndRevision(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "modelry.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	module, err := NewModule(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	module.RegisterRoutes(mux)

	get := httptest.NewRecorder()
	mux.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/admin/api/v1/project-preferences", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("read preferences = %d %s", get.Code, get.Body.String())
	}
	var initial struct {
		Data Preferences `json:"data"`
	}
	if err := json.Unmarshal(get.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	if initial.Data.Revision != 1 || initial.Data.Locale != "zh-CN" || !initial.Data.SaveFeedback {
		t.Fatalf("unexpected defaults: %s", get.Body.String())
	}

	invalid := httptest.NewRecorder()
	mux.ServeHTTP(invalid, httptest.NewRequest(http.MethodPut, "/admin/api/v1/project-preferences",
		strings.NewReader(`{"expectedRevision":1,"projectName":"x","projectDescription":"","locale":"fr-FR","appearance":"light","saveFeedback":true}`)))
	if invalid.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unsupported locale = %d %s", invalid.Code, invalid.Body.String())
	}

	saved := httptest.NewRecorder()
	mux.ServeHTTP(saved, httptest.NewRequest(http.MethodPut, "/admin/api/v1/project-preferences",
		strings.NewReader(`{"expectedRevision":1,"projectName":"拾光笔记","projectDescription":"我的本地后端","locale":"zh-CN","appearance":"light","saveFeedback":false}`)))
	if saved.Code != http.StatusOK {
		t.Fatalf("save preferences = %d %s", saved.Code, saved.Body.String())
	}
	if !strings.Contains(saved.Body.String(), `"revision":2`) || !strings.Contains(saved.Body.String(), `"saveFeedback":false`) {
		t.Fatalf("saved preferences did not reflect real state: %s", saved.Body.String())
	}

	stale := httptest.NewRecorder()
	mux.ServeHTTP(stale, httptest.NewRequest(http.MethodPut, "/admin/api/v1/project-preferences",
		strings.NewReader(`{"expectedRevision":1,"projectName":"again","projectDescription":"","locale":"zh-CN","appearance":"light","saveFeedback":true}`)))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale revision = %d %s", stale.Code, stale.Body.String())
	}
}
