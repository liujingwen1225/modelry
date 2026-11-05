package aicollab_test

import (
	"context"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/aicollab"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// TestNewModuleWiringFromExternalPackage 模拟 Runtime 在外部包里接线：
// *storage.Store 能直接传给 NewModule，且 *Module 满足 httpapi.APIModule。
func TestNewModuleWiringFromExternalPackage(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatalf("打开真实 SQLite 失败: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatalf("初始化 Backend Model 失败: %v", err)
	}
	module, err := aicollab.NewModule(store, models)
	if err != nil {
		t.Fatalf("NewModule 接线失败: %v", err)
	}
	var apiModule httpapi.APIModule = module
	mux := http.NewServeMux()
	apiModule.RegisterRoutes(mux)
}
