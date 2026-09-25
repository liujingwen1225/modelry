// Package filestore 定义 Storage Provider 中立的不可变 File object 语义。
// Records 只保存 opaque 对象引用；Provider 决定字节实际存放位置，绝不暴露路径或凭据。
package filestore

import (
	"context"
	"errors"
	"io"
	"os"
	"regexp"
	"time"
)

var (
	// ErrUnavailable 表示当前 Provider 无法完成读写；调用方必须 fail closed。
	ErrUnavailable = errors.New("file storage provider unavailable")
	// ErrNotFound 表示对象引用在 Provider 中不存在。
	ErrNotFound = errors.New("file object not found")
	// ErrObjectExists 表示对象引用已存在；不可变对象永不覆盖。
	ErrObjectExists = errors.New("file object already exists")
	// ErrInvalidArgument 表示对象引用或暂存描述不合法。
	ErrInvalidArgument = errors.New("invalid file storage argument")
	// ErrNotConfigured 表示 Provider 配置缺失或不完整。
	ErrNotConfigured = errors.New("file storage provider is not configured")
	// ErrCredentialUnavailable 表示引用的 Project Secret 缺失或无法解密。
	ErrCredentialUnavailable = errors.New("file storage credential unavailable")
	// ErrConflict 表示配置版本冲突或并发写入冲突。
	ErrConflict = errors.New("file storage conflict")
	// ErrMigrationRequired 表示有引用对象时必须先完成 migration。
	ErrMigrationRequired = errors.New("file storage migration required")
	// ErrMigrationActive 表示已经存在进行中的 migration。
	ErrMigrationActive = errors.New("file storage migration already active")
	// ErrMigrationNotActive 表示要取消的 migration 已终止。
	ErrMigrationNotActive = errors.New("file storage migration is not active")
)

// ObjectKeyPattern 是 Runtime 生成的 opaque 对象引用格式。
var ObjectKeyPattern = regexp.MustCompile(`^obj_[0-9a-f]{32}$`)

const (
	// MaxObjectBytes 是单个 File object 的硬上限。
	MaxObjectBytes = 128 << 20
	// RequestTimeout 是单对象 Provider 请求上限。
	RequestTimeout = 2 * time.Second
	// HealthTimeout 是 Provider 健康探测上限。
	HealthTimeout = 5 * time.Second
	// MaxListPage 是单次 List 返回上限。
	MaxListPage = 1000
)

// Provider 健康状态枚举。
const (
	StateReady       = "ready"
	StateDegraded    = "degraded"
	StateUnavailable = "unavailable"
	StateUnknown     = "unknown"
)

// Info 描述一个不可变对象的服务端事实。
type Info struct {
	Size        int64
	ContentType string
}

// Object 是 List 返回的安全元数据；不包含路径或桶信息。
type Object struct {
	Key        string
	Size       int64
	ModifiedAt time.Time
}

// Page 是 List 的有界分页结果。
type Page struct {
	Objects    []Object
	NextCursor string
}

// Health 是 Provider 的有界诊断快照。
type Health struct {
	State   string
	Message string
	Hint    string
}

// Staged 是调用方已经写入 Runtime 暂存目录的一次上传。
// Provider 只读取该路径，绝不把它当作可写入的长期位置。
type Staged struct {
	Path        string
	Size        int64
	ContentType string
}

// Provider 是 Storage Provider 必须实现的固定契约。
type Provider interface {
	// Name 返回稳定实现标识（local、s3）。
	Name() string
	// Label 返回面向 Owner 的 Provider 名称（Local、S3-compatible）。
	Label() string
	// Promote 把一个暂存上传写成不可变对象；目标已存在时必须失败。
	Promote(ctx context.Context, objectKey string, staged Staged) error
	// Open 返回对象内容与安全元数据；调用方负责关闭。
	Open(ctx context.Context, objectKey string) (io.ReadCloser, Info, error)
	// Stat 只读取对象的安全元数据。
	Stat(ctx context.Context, objectKey string) (Info, error)
	// Delete 删除对象；对象已不存在时视为成功。
	Delete(ctx context.Context, objectKey string) error
	// List 按引用顺序返回有界分页，cursor 为上一页最后一个引用。
	List(ctx context.Context, cursor string, limit int) (Page, error)
	// Health 执行有界、非破坏性探测。
	Health(ctx context.Context) Health
}

// ValidObjectKey 判断引用是否是可持久保存的对象引用。
func ValidObjectKey(key string) bool { return ObjectKeyPattern.MatchString(key) }

// ValidateStaged 校验暂存描述本身；不读取文件内容。
func ValidateStaged(staged Staged) error {
	if staged.Path == "" || staged.Size < 0 || staged.Size > MaxObjectBytes {
		return ErrInvalidArgument
	}
	if _, err := os.Lstat(staged.Path); err != nil {
		return ErrInvalidArgument
	}
	return nil
}

func validListLimit(limit int) (int, error) {
	if limit <= 0 || limit > MaxListPage {
		return 0, ErrInvalidArgument
	}
	return limit, nil
}
