package backendmodel

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func TestCreateCollectionOptionalTimestampFields(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	service, err := NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	var input CreateCollectionInput
	if err := json.Unmarshal([]byte(`{"name":"minimal","type":"Normal","fields":[],"omitSystemFields":["createdAt","updatedAt"]}`), &input); err != nil {
		t.Fatal(err)
	}
	collection, err := service.CreateCollection(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(collection.Fields) != 1 || collection.Fields[0].Name != "id" {
		t.Fatalf("仅保留 id，实际字段：%+v", collection.Fields)
	}
	saved, err := service.GetCollection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Fields) != 1 {
		t.Fatalf("移除时间字段未持久化：%+v", saved.Fields)
	}
	if err := validateModel(saved); err != nil {
		t.Fatal(err)
	}
	projection, err := service.GetRecordProjection(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(projection.Fields) != 3 {
		t.Fatalf("运行时时间元数据丢失：%+v", projection.Fields)
	}
	for _, payload := range []string{
		`{"name":"invalid","type":"Normal","fields":[],"omitSystemFields":["id"]}`,
		`{"name":"invalid","type":"Normal","fields":[{"name":"createdAt","type":"text"}],"omitSystemFields":["createdAt"]}`,
	} {
		var invalid CreateCollectionInput
		if err := json.Unmarshal([]byte(payload), &invalid); err != nil {
			t.Fatal(err)
		}
		if _, err := service.CreateCollection(ctx, invalid); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("非法系统字段操作应被拒绝：%v", err)
		}
	}
}
