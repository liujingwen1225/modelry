// Package activity 提供由各子系统产品事实构成的通用 Activity 时间线。
// 它有意不读取 RequestRecord 或 AuditRecord：Activity 是运维读模型，不是请求日志或审计记录。
package activity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

var (
	// ErrInvalidArgument 表示查询参数或响应标识不合法。
	ErrInvalidArgument = errors.New("invalid activity argument")
	// ErrStorage 表示事实读取失败。
	ErrStorage = errors.New("activity storage unavailable")
)

// Kind 是一条 Activity 事实的类别。
type Kind string

const (
	KindChangeApplied    Kind = "change.applied"
	KindChangePending    Kind = "change.pending"
	KindChangeFailed     Kind = "change.failed"
	KindWebhookDelivery  Kind = "webhook.delivery"
	KindJobRun           Kind = "job.run"
	KindExtensionRun     Kind = "extension.run"
	KindMailDelivery     Kind = "mail.delivery"
	KindStorageMigration Kind = "storage.migration"
	KindAuthRecovery     Kind = "auth.recovery"
)

// SupportedKinds 返回全部受支持的 Activity 类别。
func SupportedKinds() []Kind {
	return []Kind{
		KindChangeApplied, KindChangePending, KindChangeFailed, KindWebhookDelivery, KindJobRun,
		KindExtensionRun, KindMailDelivery, KindStorageMigration, KindAuthRecovery,
	}
}

func knownKind(kind Kind) bool {
	for _, candidate := range SupportedKinds() {
		if candidate == kind {
			return true
		}
	}
	return false
}

// Fact 是一条结构化 Activity 事实。
// 它有意不携带 payload、message body、token、凭据、Secret 值或 App User email。
type Fact struct {
	ID           string    `json:"id"`
	Kind         Kind      `json:"kind"`
	Status       string    `json:"status"`
	OccurredAt   time.Time `json:"occurredAt"`
	ResourceKind string    `json:"resourceKind"`
	ResourceID   string    `json:"resourceId"`
	CollectionID string    `json:"collectionId,omitempty"`
	Title        string    `json:"title,omitempty"`
	DeepLink     string    `json:"deepLink"`
}

// Source 由拥有事实的子系统实现；它只读取自己的表，并使用调用方提供的事务。
type Source interface {
	Facts(ctx context.Context, query storage.Executor, limit int) ([]Fact, error)
}

type transactionalStore interface {
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

// Service 合并所有来源的事实并按时间倒序分页。
type Service struct {
	store   transactionalStore
	sources []Source
}

// NewService 创建 Activity 服务。没有来源时列表为空，而不是报错。
func NewService(store transactionalStore, sources ...Source) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("%w: SQLite store is required", ErrInvalidArgument)
	}
	filtered := make([]Source, 0, len(sources))
	for _, source := range sources {
		if source != nil {
			filtered = append(filtered, source)
		}
	}
	return &Service{store: store, sources: filtered}, nil
}

// ListOptions 是 Activity 的查询参数。
type ListOptions struct {
	Limit        int
	Cursor       string
	Kinds        []Kind
	CollectionID string
}

// Page 是一页 Activity 事实。
type Page struct {
	Data       []Fact `json:"data"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// 单个来源每页读取的候选上限，以及返回事实的上限。
const (
	DefaultLimit         = 20
	MaximumLimit         = 50
	maximumSourceFacts   = 500
	maximumCursorBytes   = 512
	maximumDeepLinkBytes = 512
)

type cursorPosition struct {
	OccurredAt time.Time `json:"occurredAt"`
	ID         string    `json:"id"`
}

func encodeCursor(fact Fact) (string, error) {
	encoded, err := json.Marshal(cursorPosition{OccurredAt: fact.OccurredAt.UTC(), ID: fact.ID})
	if err != nil {
		return "", fmt.Errorf("%w: Activity cursor could not be encoded", ErrInvalidArgument)
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func decodeCursor(value string) (cursorPosition, error) {
	if value == "" {
		return cursorPosition{}, nil
	}
	if len(value) > maximumCursorBytes {
		return cursorPosition{}, fmt.Errorf("%w: Activity cursor is too long", ErrInvalidArgument)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return cursorPosition{}, fmt.Errorf("%w: Activity cursor is not decodable", ErrInvalidArgument)
	}
	var position cursorPosition
	if err := json.Unmarshal(decoded, &position); err != nil {
		return cursorPosition{}, fmt.Errorf("%w: Activity cursor is not readable", ErrInvalidArgument)
	}
	if position.ID == "" || position.OccurredAt.IsZero() {
		return cursorPosition{}, fmt.Errorf("%w: Activity cursor is incomplete", ErrInvalidArgument)
	}
	return position, nil
}

func normalizeOptions(options ListOptions) (ListOptions, error) {
	normalized := options
	if normalized.Limit == 0 {
		normalized.Limit = DefaultLimit
	}
	if normalized.Limit < 1 || normalized.Limit > MaximumLimit {
		return ListOptions{}, fmt.Errorf("%w: Activity limit must be between 1 and %d", ErrInvalidArgument, MaximumLimit)
	}
	seen := map[Kind]struct{}{}
	kinds := make([]Kind, 0, len(normalized.Kinds))
	for _, kind := range normalized.Kinds {
		if !knownKind(kind) {
			return ListOptions{}, fmt.Errorf("%w: Activity kind %q is unsupported", ErrInvalidArgument, kind)
		}
		if _, exists := seen[kind]; exists {
			continue
		}
		seen[kind] = struct{}{}
		kinds = append(kinds, kind)
	}
	normalized.Kinds = kinds
	normalized.CollectionID = strings.TrimSpace(normalized.CollectionID)
	if len(normalized.CollectionID) > 128 {
		return ListOptions{}, fmt.Errorf("%w: Activity Collection filter is too long", ErrInvalidArgument)
	}
	return normalized, nil
}

// List 返回一页经过过滤、排序并分页的 Activity 事实。
func (service *Service) List(ctx context.Context, options ListOptions) (Page, error) {
	if service == nil || service.store == nil {
		return Page{}, fmt.Errorf("%w: Activity service is not ready", ErrStorage)
	}
	normalized, err := normalizeOptions(options)
	if err != nil {
		return Page{}, err
	}
	position, err := decodeCursor(normalized.Cursor)
	if err != nil {
		return Page{}, err
	}
	kinds := make(map[Kind]struct{}, len(normalized.Kinds))
	for _, kind := range normalized.Kinds {
		kinds[kind] = struct{}{}
	}
	collected := make([]Fact, 0, normalized.Limit+1)
	err = service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		for _, source := range service.sources {
			facts, err := source.Facts(ctx, snapshot, maximumSourceFacts)
			if err != nil {
				return err
			}
			for _, fact := range facts {
				if len(kinds) > 0 {
					if _, ok := kinds[fact.Kind]; !ok {
						continue
					}
				}
				if normalized.CollectionID != "" && fact.CollectionID != normalized.CollectionID {
					continue
				}
				if fact.ID == "" || fact.OccurredAt.IsZero() || len(fact.DeepLink) > maximumDeepLinkBytes {
					continue
				}
				if !position.OccurredAt.IsZero() && !after(position, fact) {
					continue
				}
				collected = append(collected, fact)
			}
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return Page{}, err
		}
		return Page{}, fmt.Errorf("%w: %v", ErrStorage, err)
	}
	sortFacts(collected)
	page := Page{Data: make([]Fact, 0, normalized.Limit)}
	for _, fact := range collected {
		if len(page.Data) == normalized.Limit {
			next, err := encodeCursor(page.Data[len(page.Data)-1])
			if err != nil {
				return Page{}, err
			}
			page.NextCursor = next
			break
		}
		page.Data = append(page.Data, fact)
	}
	return page, nil
}

// after 判断 fact 是否严格位于游标之后（时间倒序序列中的更早位置）。
func after(position cursorPosition, fact Fact) bool {
	if fact.OccurredAt.Before(position.OccurredAt) {
		return true
	}
	if fact.OccurredAt.After(position.OccurredAt) {
		return false
	}
	return fact.ID < position.ID
}

func sortFacts(facts []Fact) {
	sort.SliceStable(facts, func(left, right int) bool {
		if !facts[left].OccurredAt.Equal(facts[right].OccurredAt) {
			return facts[left].OccurredAt.After(facts[right].OccurredAt)
		}
		return facts[left].ID > facts[right].ID
	})
}