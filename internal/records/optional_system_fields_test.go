package records

import (
	"context"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"testing"
)

func TestRecordCRUDWithoutTimestampModelFields(t *testing.T) {
	ctx := context.Background()
	_, models, records := newTestServices(t)
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "minimal", Type: backendmodel.CollectionTypeNormal,
		OmitSystemFields: []string{"createdAt", "updatedAt"},
		Fields:           []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	created, err := records.Create(ctx, collection.ID, map[string]any{"title": "first"})
	if err != nil {
		t.Fatal(err)
	}
	if created.CreatedAt == "" || created.UpdatedAt != created.CreatedAt {
		t.Fatalf("记录元数据不完整：%+v", created)
	}
	updated, err := records.Update(ctx, collection.ID, created.ID, map[string]any{"title": "second"})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := records.Get(ctx, collection.ID, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Values["title"] != "second" || saved.CreatedAt != created.CreatedAt || saved.UpdatedAt != updated.UpdatedAt {
		t.Fatalf("记录未耐久保存：%+v", saved)
	}
	listed, err := records.List(ctx, collection.ID, ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Data) != 1 || listed.Data[0].ID != created.ID {
		t.Fatalf("默认排序列表不可用：%+v", listed)
	}

	if _, err := records.Create(ctx, collection.ID, map[string]any{"createdAt": "2026-01-01T00:00:00Z"}); err == nil {
		t.Fatal("不能写入运行时时间元数据")
	}
}
