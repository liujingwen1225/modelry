package backendapi

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestCreateCollectionHTTPOptionalTimestampFields(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "modelry.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service, err := backendmodel.NewService(t.Context(), store)
	if err != nil {
		t.Fatal(err)
	}
	handler := httpapi.NewHandler(nil, nil, httpapi.NewAPIRouter(NewModule(service)))
	created := performJSON(t, handler, http.MethodPost, "/admin/api/v1/collections", `{"name":"minimal","type":"Normal","fields":[],"omitSystemFields":["createdAt","updatedAt"]}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("创建失败：%d %s", created.Code, created.Body.String())
	}
	var result struct {
		Data backendmodel.Collection `json:"data"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Data.Fields) != 1 || result.Data.Fields[0].Name != "id" {
		t.Fatalf("创建结果字段错误：%+v", result.Data.Fields)
	}
	reloaded, err := backendmodel.NewService(t.Context(), store)
	if err != nil {
		t.Fatal(err)
	}
	handler = httpapi.NewHandler(nil, nil, httpapi.NewAPIRouter(NewModule(reloaded)))
	got := performJSON(t, handler, http.MethodGet, "/admin/api/v1/collections/"+result.Data.ID, "")
	if got.Code != http.StatusOK {
		t.Fatalf("重新读取失败：%s", got.Body.String())
	}
	if err := json.Unmarshal(got.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Data.Fields) != 1 {
		t.Fatalf("重载后时间字段又出现：%+v", result.Data.Fields)
	}
	invalid := performJSON(t, handler, http.MethodPost, "/admin/api/v1/collections", `{"name":"invalid","type":"Normal","fields":[],"omitSystemFields":["id"]}`)
	if invalid.Code < 400 || invalid.Code >= 500 {
		t.Fatalf("省略 id 未被拒绝：%d", invalid.Code)
	}
}
