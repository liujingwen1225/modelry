package agenttools

import (
	"encoding/json"
	"testing"
)

func TestToolSchemasDoNotSerializeNullRequiredAndCollectionTypeIsCanonical(t *testing.T) {
	var inspect func(any)
	inspect = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			for key, item := range v {
				if key == "required" && item == nil {
					t.Fatal("JSON Schema required 不能为 null")
				}
				inspect(item)
			}
		case []any:
			for _, item := range v {
				inspect(item)
			}
		}
	}
	for _, tool := range Tools() {
		encoded, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Fatal(err)
		}
		var value any
		json.Unmarshal(encoded, &value)
		inspect(value)
	}
	if _, err := BuildCall("collections_create", map[string]any{"body": map[string]any{"name": "notes", "type": "normal"}}); err == nil {
		t.Fatal("接受了非产品集合类型")
	}
}
