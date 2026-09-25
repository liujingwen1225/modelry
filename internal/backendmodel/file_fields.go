package backendmodel

import (
	"encoding/json"
	"fmt"
	"mime"
	"strings"
)

// File Field 约束的固定边界。它们同时约束上传、Pending change 校验与 OpenAPI 文档。
const (
	// MaximumFileBytes 是单个 File value 的硬上限。
	MaximumFileBytes = 128 << 20
	// DefaultFileBytes 是未声明 maxBytes 时的默认单文件上限。
	DefaultFileBytes = 10 << 20
	// MaximumFileCount 是一个 files Field 允许的最大数量。
	MaximumFileCount = 32
	// DefaultFileCount 是未声明 maxFiles 时的默认数量上限。
	DefaultFileCount = 8
	// MaximumFileMIMETypes 是一个 Field 允许声明的 MIME 条目上限。
	MaximumFileMIMETypes = 16
)

// FileFieldConstraints 是 Applied File Field 的产品约束。
// 调用方只能在上传时进一步收紧，永远不能放宽。
type FileFieldConstraints struct {
	MaxBytes         int64
	AllowedMIMETypes []string
	MaxFiles         int
}

// DefaultFileMIMETypes 返回未声明 allowedMimeTypes 时的安全默认集合。
func DefaultFileMIMETypes() []string {
	return []string{"application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp", "text/csv", "text/plain"}
}

// AppliedFileConstraints 解析并校验 File Field 的约束声明。
// validation 里出现未知键、非法范围或非法 MIME 时一律 fail closed。
func AppliedFileConstraints(field Field) (FileFieldConstraints, error) {
	constraints := FileFieldConstraints{
		MaxBytes:         DefaultFileBytes,
		AllowedMIMETypes: DefaultFileMIMETypes(),
		MaxFiles:         DefaultFileCount,
	}
	if len(field.Validation) == 0 {
		return constraints, nil
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(field.Validation, &values); err != nil {
		return FileFieldConstraints{}, fmt.Errorf("%w: File Field constraints are invalid", ErrInvalidArgument)
	}
	for key := range values {
		switch key {
		case "maxBytes", "allowedMimeTypes", "maxFiles":
		default:
			return FileFieldConstraints{}, fmt.Errorf("%w: unsupported File Field constraint %q", ErrInvalidArgument, key)
		}
	}
	if raw, exists := values["maxBytes"]; exists {
		if err := json.Unmarshal(raw, &constraints.MaxBytes); err != nil || constraints.MaxBytes < 1 || constraints.MaxBytes > MaximumFileBytes {
			return FileFieldConstraints{}, fmt.Errorf("%w: File Field maxBytes must be between 1 and %d", ErrInvalidArgument, MaximumFileBytes)
		}
	}
	if raw, exists := values["maxFiles"]; exists {
		if err := json.Unmarshal(raw, &constraints.MaxFiles); err != nil || constraints.MaxFiles < 1 || constraints.MaxFiles > MaximumFileCount {
			return FileFieldConstraints{}, fmt.Errorf("%w: File Field maxFiles must be between 1 and %d", ErrInvalidArgument, MaximumFileCount)
		}
	}
	if raw, exists := values["allowedMimeTypes"]; exists {
		var declared []string
		if err := json.Unmarshal(raw, &declared); err != nil || len(declared) == 0 || len(declared) > MaximumFileMIMETypes {
			return FileFieldConstraints{}, fmt.Errorf("%w: File Field allowedMimeTypes must contain between 1 and %d entries", ErrInvalidArgument, MaximumFileMIMETypes)
		}
		normalized, err := NormalizeMIMETypes(declared)
		if err != nil {
			return FileFieldConstraints{}, err
		}
		constraints.AllowedMIMETypes = normalized
	}
	return constraints, nil
}

// NormalizeMIMETypes 校验、去重并小写化 MIME 声明；支持 type/* 通配。
func NormalizeMIMETypes(values []string) ([]string, error) {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		normalized, err := normalizeMIMEType(value)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("%w: at least one allowed MIME type is required", ErrInvalidArgument)
	}
	return result, nil
}

func normalizeMIMEType(value string) (string, error) {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	if trimmed == "" {
		return "", fmt.Errorf("%w: allowed MIME types cannot be empty", ErrInvalidArgument)
	}
	if strings.HasSuffix(trimmed, "/*") {
		if strings.Count(trimmed, "/") != 1 || len(trimmed) < 3 {
			return "", fmt.Errorf("%w: invalid MIME wildcard %q", ErrInvalidArgument, value)
		}
		prefix := strings.TrimSuffix(trimmed, "/*")
		for _, r := range prefix {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' && r != '+' && r != '.' {
				return "", fmt.Errorf("%w: invalid MIME wildcard %q", ErrInvalidArgument, value)
			}
		}
		return trimmed, nil
	}
	parsed, _, err := mime.ParseMediaType(trimmed)
	if err != nil {
		return "", fmt.Errorf("%w: invalid allowed MIME type %q", ErrInvalidArgument, value)
	}
	if _, _, err := mime.ParseMediaType(parsed); err != nil {
		return "", fmt.Errorf("%w: invalid allowed MIME type %q", ErrInvalidArgument, value)
	}
	return parsed, nil
}

// MIMEAllowed 判断一个具体 MIME 是否被允许集合覆盖。
func MIMEAllowed(value string, allowed []string) bool {
	for _, candidate := range allowed {
		if candidate == value {
			return true
		}
		if strings.HasSuffix(candidate, "/*") && strings.HasPrefix(value, strings.TrimSuffix(candidate, "*")) {
			return true
		}
	}
	return false
}

// MIMESubset 判断请求策略是否被 Applied Field 约束覆盖。
func MIMESubset(requested string, configured []string) bool {
	if strings.HasSuffix(requested, "/*") {
		for _, allowed := range configured {
			if requested == allowed {
				return true
			}
		}
		return false
	}
	return MIMEAllowed(requested, configured)
}

// validateFileFieldConstraints 是 Change 校验的一部分；它同时拒绝只对 files 有意义的约束。
func validateFileFieldConstraints(field Field) error {
	if _, err := AppliedFileConstraints(field); err != nil {
		return err
	}
	if field.Type == FieldTypeFile && hasFileValidationKey(field.Validation, "maxFiles") {
		return fmt.Errorf("%w: only files Fields can define maxFiles", ErrInvalidArgument)
	}
	if field.Type == FieldTypeFiles && field.Unique {
		return fmt.Errorf("%w: a files Field cannot be unique", ErrInvalidArgument)
	}
	return nil
}

func hasFileValidationKey(validation json.RawMessage, key string) bool {
	if len(validation) == 0 {
		return false
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(validation, &values); err != nil {
		return false
	}
	_, exists := values[key]
	return exists
}
