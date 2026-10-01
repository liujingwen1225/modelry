// Package overview 提供 Admin 总览所需的一次性聚合事实。
//
// 它不拥有自己的表：每个 section 都通过所属领域服务的窄方法取得事实，
// 因此不会出现第二个事实来源，也不会跨模块直接读表。
// 每个 section 都是可选的——section 缺失表示"当前读不到"，而不是"零"。
package overview

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/liujingwen1225/modelry/internal/automation"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/drift"
	"github.com/liujingwen1225/modelry/internal/extensions"
	"github.com/liujingwen1225/modelry/internal/requests"
)

// DefaultWindow 是总览摘要使用的默认时间窗口。
const DefaultWindow = 24 * time.Hour

const (
	collectionPageSize    = 100
	maximumCollections    = 2000
	changePageSize        = 100
	maximumPendingChanges = 2000
	recentCollectionCount = 5
)

// ErrUnavailable 表示所有尝试过的 section 都读取失败。
var ErrUnavailable = errors.New("overview facts are unavailable")

// Options 描述本次聚合的窗口与调用方权限允许包含的可选字段。
type Options struct {
	// Window 为 0 时使用 DefaultWindow。
	Window time.Duration
	// IncludeRecordCount 需要 records.read；缺失时记录数省略而不报错。
	IncludeRecordCount bool
	// IncludeSchemaStatus 需要 schema.read；缺失时待应用变更状态省略。
	IncludeSchemaStatus bool
}

// RecentCollection 是"继续工作"区域需要的轻量集合摘要。
type RecentCollection struct {
	ID                  string                   `json:"id"`
	Name                string                   `json:"name"`
	Type                backendmodel.CollectionType `json:"type"`
	RecordCount         *int64                   `json:"recordCount,omitempty"`
	FieldCount          int                      `json:"fieldCount"`
	RelationCount       int                      `json:"relationCount"`
	IndexCount          int                      `json:"indexCount"`
	PendingChangeStatus backendmodel.ChangeStatus `json:"pendingChangeStatus,omitempty"`
	UpdatedAt           time.Time                `json:"updatedAt"`
}

// CollectionsSection 是集合规模与结构状态的摘要。
type CollectionsSection struct {
	Count              int                `json:"count"`
	RecordCount        *int64             `json:"recordCount,omitempty"`
	WithPendingChanges int                `json:"withPendingChanges"`
	WithFailedChanges  int                `json:"withFailedChanges"`
	Recent             []RecentCollection `json:"recent,omitempty"`
}

// RequestsSection 是应用请求日志在窗口内的摘要。
type RequestsSection struct {
	WindowSeconds     int        `json:"windowSeconds"`
	WindowCoveredFrom *time.Time `json:"windowCoveredFrom,omitempty"`
	RequestCount      int64      `json:"requestCount"`
	ClientErrorCount  int64      `json:"clientErrorCount"`
	ServerErrorCount  int64      `json:"serverErrorCount"`
	P95DurationMS     *int64     `json:"p95DurationMs,omitempty"`
}

// EventsSection 是事件驱动能力与定时任务在窗口内的摘要。
type EventsSection struct {
	EnabledHooks         int   `json:"enabledHooks"`
	EnabledWebhooks      int   `json:"enabledWebhooks"`
	EnabledEventHooks    int   `json:"enabledEventHooks"`
	EnabledJobs          int   `json:"enabledJobs"`
	RunCount             int64 `json:"runCount"`
	DeliveryCount        int64 `json:"deliveryCount"`
	FailedDeliveryCount  int64 `json:"failedDeliveryCount"`
	PendingDeliveryCount int64 `json:"pendingDeliveryCount"`
}

// ChangesSection 是待应用变更的摘要。
type ChangesSection struct {
	PendingCount     int `json:"pendingCount"`
	NeedsReviewCount int `json:"needsReviewCount"`
	FailedCount      int `json:"failedCount"`
}

// DriftSection 是最近一次结构漂移检查的结论。
type DriftSection struct {
	State           string    `json:"state"`
	DifferenceCount int       `json:"differenceCount"`
	CheckedAt       time.Time `json:"checkedAt"`
}

// Snapshot 是总览的完整事实集合；nil section 表示该部分当前不可读。
type Snapshot struct {
	GeneratedAt   time.Time           `json:"generatedAt"`
	WindowSeconds int                 `json:"windowSeconds"`
	Collections   *CollectionsSection `json:"collections,omitempty"`
	Requests      *RequestsSection    `json:"requests,omitempty"`
	Events        *EventsSection      `json:"events,omitempty"`
	Changes       *ChangesSection     `json:"changes,omitempty"`
	Drift         *DriftSection       `json:"drift,omitempty"`
}

type collectionSource interface {
	ListCollectionSummaries(context.Context, backendmodel.ListOptions, backendmodel.CollectionSummaryOptions) (backendmodel.Page[backendmodel.CollectionSummary], error)
	ListChanges(context.Context, backendmodel.ListOptions) (backendmodel.Page[backendmodel.ChangeEntry], error)
}

type requestSummarySource interface {
	Summary(context.Context, time.Time) (requests.Summary, error)
}

type automationSummarySource interface {
	Summary(context.Context, time.Time) (automation.Summary, error)
}

type extensionSummarySource interface {
	Summary(context.Context, time.Time) (extensions.HookSummary, error)
}

type driftReportSource interface {
	Report(context.Context, string) (drift.Report, error)
}

// Service 聚合总览事实。
type Service struct {
	collections collectionSource
	requestFacts requestSummarySource
	automationFacts automationSummarySource
	extensionFacts  extensionSummarySource
	driftFacts      driftReportSource
	now             func() time.Time
}

// NewService 创建总览聚合服务。缺少任何来源时该 section 会被省略，
// 因此所有来源都必须显式给出，避免静默降级。
func NewService(collections collectionSource, requestFacts requestSummarySource, automationFacts automationSummarySource, extensionFacts extensionSummarySource, driftFacts driftReportSource) (*Service, error) {
	if collections == nil || requestFacts == nil || automationFacts == nil || extensionFacts == nil || driftFacts == nil {
		return nil, fmt.Errorf("overview requires all fact sources: %w", ErrUnavailable)
	}
	return &Service{
		collections: collections, requestFacts: requestFacts, automationFacts: automationFacts,
		extensionFacts: extensionFacts, driftFacts: driftFacts, now: func() time.Time { return time.Now().UTC() },
	}, nil
}

// Snapshot 读取全部 section。单个 section 失败时它会被省略，其它 section 照常返回；
// 只有全部 section 都失败时才返回错误，避免把"读不到"呈现成"空项目"。
func (service *Service) Snapshot(ctx context.Context, options Options) (Snapshot, error) {
	if service == nil {
		return Snapshot{}, fmt.Errorf("overview service is not ready: %w", ErrUnavailable)
	}
	window := options.Window
	if window <= 0 {
		window = DefaultWindow
	}
	now := service.now().UTC()
	since := now.Add(-window)
	snapshot := Snapshot{GeneratedAt: now, WindowSeconds: int(window.Seconds())}

	attempted, succeeded := 0, 0
	attempt := func(apply func()) {
		attempted++
		apply()
	}

	attempt(func() {
		if section, err := service.collectionSection(ctx, options); err == nil {
			snapshot.Collections = section
			succeeded++
		}
	})
	attempt(func() {
		if section, err := service.requestSection(ctx, since, window); err == nil {
			snapshot.Requests = section
			succeeded++
		}
	})
	attempt(func() {
		if section, err := service.eventSection(ctx, since); err == nil {
			snapshot.Events = section
			succeeded++
		}
	})
	attempt(func() {
		if section, err := service.changeSection(ctx); err == nil {
			snapshot.Changes = section
			succeeded++
		}
	})
	attempt(func() {
		if section, err := service.driftSection(ctx); err == nil {
			snapshot.Drift = section
			succeeded++
		}
	})

	if attempted > 0 && succeeded == 0 {
		return Snapshot{}, fmt.Errorf("%w: no overview section could be read", ErrUnavailable)
	}
	return snapshot, nil
}

func (service *Service) collectionSection(ctx context.Context, options Options) (*CollectionsSection, error) {
	summaries, err := service.collectionSummaries(ctx, options)
	if err != nil {
		return nil, err
	}
	section := &CollectionsSection{Count: len(summaries)}
	if options.IncludeRecordCount {
		var total int64
		for _, summary := range summaries {
			total += summary.RecordCount
		}
		section.RecordCount = &total
	}
	for _, summary := range summaries {
		switch summary.PendingChangeStatus {
		case backendmodel.ChangeFailed:
			section.WithFailedChanges++
			section.WithPendingChanges++
		case backendmodel.ChangeReady, backendmodel.ChangeNeedsReview:
			section.WithPendingChanges++
		}
	}
	ordered := append([]backendmodel.CollectionSummary(nil), summaries...)
	sort.SliceStable(ordered, func(left, right int) bool {
		return ordered[left].UpdatedAt.After(ordered[right].UpdatedAt)
	})
	for _, summary := range ordered {
		if len(section.Recent) >= recentCollectionCount {
			break
		}
		recent := RecentCollection{
			ID: summary.ID, Name: summary.Name, Type: summary.Type,
			FieldCount: len(summary.Fields), IndexCount: len(summary.Indexes), UpdatedAt: summary.UpdatedAt,
		}
		for _, field := range summary.Fields {
			if field.Type == backendmodel.FieldTypeRelation {
				recent.RelationCount++
			}
		}
		if options.IncludeRecordCount {
			count := summary.RecordCount
			recent.RecordCount = &count
		}
		if options.IncludeSchemaStatus {
			recent.PendingChangeStatus = summary.PendingChangeStatus
		}
		section.Recent = append(section.Recent, recent)
	}
	return section, nil
}

func (service *Service) collectionSummaries(ctx context.Context, options Options) ([]backendmodel.CollectionSummary, error) {
	summaries := make([]backendmodel.CollectionSummary, 0, collectionPageSize)
	cursor := ""
	for len(summaries) < maximumCollections {
		page, err := service.collections.ListCollectionSummaries(ctx, backendmodel.ListOptions{Limit: collectionPageSize, Cursor: cursor}, backendmodel.CollectionSummaryOptions{
			IncludeRecordCount:         options.IncludeRecordCount,
			IncludePendingChangeStatus: options.IncludeSchemaStatus,
		})
		if err != nil {
			return nil, err
		}
		summaries = append(summaries, page.Data...)
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	return summaries, nil
}

func (service *Service) requestSection(ctx context.Context, since time.Time, window time.Duration) (*RequestsSection, error) {
	summary, err := service.requestFacts.Summary(ctx, since)
	if err != nil {
		return nil, err
	}
	return &RequestsSection{
		WindowSeconds:     int(window.Seconds()),
		WindowCoveredFrom: summary.WindowCoveredFrom,
		RequestCount:      summary.RequestCount,
		ClientErrorCount:  summary.ClientErrorCount,
		ServerErrorCount:  summary.ServerErrorCount,
		P95DurationMS:     summary.P95DurationMS,
	}, nil
}

func (service *Service) eventSection(ctx context.Context, since time.Time) (*EventsSection, error) {
	deliveries, err := service.automationFacts.Summary(ctx, since)
	if err != nil {
		return nil, err
	}
	runs, err := service.extensionFacts.Summary(ctx, since)
	if err != nil {
		return nil, err
	}
	return &EventsSection{
		EnabledHooks:         runs.Enabled,
		EnabledWebhooks:      deliveries.EnabledWebhooks,
		EnabledEventHooks:    deliveries.EnabledEventHooks,
		EnabledJobs:          deliveries.EnabledJobs,
		RunCount:             runs.RunCount,
		DeliveryCount:        deliveries.DeliveryCount,
		FailedDeliveryCount:  deliveries.FailedDeliveryCount,
		PendingDeliveryCount: deliveries.PendingDeliveryCount,
	}, nil
}

func (service *Service) changeSection(ctx context.Context) (*ChangesSection, error) {
	section := &ChangesSection{}
	cursor := ""
	seen := 0
	for seen < maximumPendingChanges {
		page, err := service.collections.ListChanges(ctx, backendmodel.ListOptions{Limit: changePageSize, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		for _, entry := range page.Data {
			if entry.PendingChange == nil {
				continue
			}
			seen++
			section.PendingCount++
			switch entry.PendingChange.Status {
			case backendmodel.ChangeNeedsReview:
				section.NeedsReviewCount++
			case backendmodel.ChangeFailed:
				section.FailedCount++
			}
		}
		if len(page.Data) == 0 || page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	return section, nil
}

func (service *Service) driftSection(ctx context.Context) (*DriftSection, error) {
	report, err := service.driftFacts.Report(ctx, "")
	if err != nil {
		return nil, err
	}
	return &DriftSection{State: report.State, DifferenceCount: len(report.Findings), CheckedAt: report.DetectedAt}, nil
}
