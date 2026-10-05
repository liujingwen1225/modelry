package agent

import (
	"context"
	"strings"
)

// 记录写入可能触发自动化；看不到依赖时保守要求确认。
func (s *Service) recordSideEffects(ctx context.Context, name string, args map[string]any) bool {
	if name != "records_create" && name != "records_update" {
		return false
	}
	collection, _ := args["collectionId"].(string)
	for _, tool := range []string{"hooks_list", "event_hooks_list"} {
		result, err := s.invoke(ctx, tool, map[string]any{})
		if err != nil {
			return true
		}
		items, ok := unwrap(result).([]any)
		if !ok {
			return true
		}
		for _, item := range items {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			active, _ := m["enabled"].(bool)
			if !active {
				continue
			}
			if tool == "event_hooks_list" {
				if m["collectionId"] == collection {
					return true
				}
				continue
			}
			bindings, ok := m["bindings"].([]any)
			if !ok {
				id, valid := m["id"].(string)
				if !valid {
					return true
				}
				detail, err := s.invoke(ctx, "hooks_get", map[string]any{"extensionId": id})
				if err != nil {
					return true
				}
				configuration, valid := unwrap(detail).(map[string]any)
				if !valid {
					return true
				}
				bindings, ok = configuration["bindings"].([]any)
				if !ok {
					return true
				}
			}
			for _, binding := range bindings {
				b, ok := binding.(map[string]any)
				if ok && b["collectionId"] == collection && strings.TrimPrefix(name, "records_") == b["operation"] {
					return true
				}
			}
		}
	}
	return false
}
