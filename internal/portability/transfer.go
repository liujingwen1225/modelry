package portability

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
)

// RecordSource 提供 Export/Import 所需的已提交 Record 读写。
// Import 必须经由 Create，因此 Validation、Relation 与 File 语义与 Application API 完全一致。
type RecordSource interface {
	List(ctx context.Context, collectionID string, options records.ListOptions) (records.Page, error)
	Create(ctx context.Context, collectionID string, values map[string]any) (records.Record, error)
}

// CollectionResolver 按名称或 id 解析 Applied Collection。
type CollectionResolver interface {
	GetCollection(ctx context.Context, collectionID string) (backendmodel.Collection, error)
	ListCollections(ctx context.Context, options backendmodel.ListOptions) (backendmodel.Page[backendmodel.Collection], error)
}

// ExportHeader 是 NDJSON 的第一行。
type ExportHeader struct {
	Kind             string             `json:"kind"`
	CollectionID     string             `json:"collectionId"`
	Name             string             `json:"name"`
	Type             string             `json:"type"`
	AppliedModelHash string             `json:"appliedModelHash"`
	Fields           []canonicalField   `json:"fields"`
}

// ExportRecordLine 是 NDJSON 的每条 Record。
type ExportRecordLine struct {
	Kind   string         `json:"kind"`
	ID     string         `json:"id,omitempty"`
	Values map[string]any `json:"values"`
}

// ImportLine 是 Import 接受的 Record 行。
type ImportLine struct {
	Kind   string         `json:"kind"`
	Values map[string]any `json:"values"`
}

// ImportResult 是单条 Record 的导入结果。
type ImportResult struct {
	Index    int    `json:"index"`
	Status   string `json:"status"`
	RecordID string `json:"recordId,omitempty"`
	Code     string `json:"code,omitempty"`
}

// ImportSummary 是一次 Import 的汇总。
type ImportSummary struct {
	Created int64          `json:"created"`
	Failed  int64          `json:"failed"`
	Results []ImportResult `json:"results"`
}

// ExportStream 以 NDJSON 写出一个 Collection 的 header 与全部 Record。
func (service *Service) ExportStream(ctx context.Context, source RecordSource, resolver CollectionResolver, collectionID string, destination io.Writer) error {
	if source == nil || resolver == nil {
		return fmt.Errorf("%w: Record source and Collection resolver are required", ErrInvalidArgument)
	}
	collection, err := resolver.GetCollection(ctx, collectionID)
	if err != nil {
		return err
	}
	modelHash, err := service.AppliedModelHash(ctx)
	if err != nil {
		return err
	}
	writer := bufio.NewWriter(destination)
	header := ExportHeader{Kind: "collection", CollectionID: collection.ID, Name: collection.Name, Type: string(collection.Type), AppliedModelHash: modelHash}
	for _, field := range collection.Fields {
		if field.System {
			continue
		}
		projected := canonicalField{ID: field.ID, Name: field.Name, Type: string(field.Type), Required: field.Required, Unique: field.Unique}
		if field.Relation != nil {
			projected.RelationTarget = field.Relation.TargetCollectionID
			projected.RelationCardinality = field.Relation.Cardinality
		}
		header.Fields = append(header.Fields, projected)
	}
	sort.SliceStable(header.Fields, func(left, right int) bool { return header.Fields[left].Name < header.Fields[right].Name })
	encoded, err := json.Marshal(header)
	if err != nil {
		return fmt.Errorf("%w: encode export header: %v", ErrStorage, err)
	}
	if _, err := writer.Write(append(encoded, '\n')); err != nil {
		return fmt.Errorf("%w: write export header: %v", ErrStorage, err)
	}

	cursor := ""
	exported := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		page, err := source.List(ctx, collection.ID, records.ListOptions{Limit: 100, Cursor: cursor})
		if err != nil {
			return err
		}
		for _, record := range page.Data {
			line := ExportRecordLine{Kind: "record", ID: record.ID, Values: safeRecordValues(record.Values)}
			encoded, err := json.Marshal(line)
			if err != nil {
				return fmt.Errorf("%w: encode export record: %v", ErrStorage, err)
			}
			if _, err := writer.Write(append(encoded, '\n')); err != nil {
				return fmt.Errorf("%w: write export record: %v", ErrStorage, err)
			}
			exported++
			if exported >= maximumExportRecords {
				return writer.Flush()
			}
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	return writer.Flush()
}

// safeRecordValues 只导出产品允许搬移的值：永不导出 Password Credential 或 Secret 材料。
func safeRecordValues(values map[string]any) map[string]any {
	projected := make(map[string]any, len(values))
	for key, value := range values {
		switch strings.ToLower(key) {
		case "password", "passwordhash", "password_hash", "token", "secret":
			continue
		default:
			projected[key] = value
		}
	}
	return projected
}

// ImportStream 读取 NDJSON 并通过 Record 创建路径导入每条 Record。
func (service *Service) ImportStream(ctx context.Context, source RecordSource, resolver CollectionResolver, collectionID string, input io.Reader) (ImportSummary, error) {
	if source == nil || resolver == nil {
		return ImportSummary{}, fmt.Errorf("%w: Record source and Collection resolver are required", ErrInvalidArgument)
	}
	collection, err := resolver.GetCollection(ctx, collectionID)
	if err != nil {
		return ImportSummary{}, err
	}
	modelHash, err := service.AppliedModelHash(ctx)
	if err != nil {
		return ImportSummary{}, err
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	summary := ImportSummary{Results: make([]ImportResult, 0, 16)}
	index := 0
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return summary, err
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if index == 0 {
			var header ExportHeader
			if err := json.Unmarshal([]byte(line), &header); err != nil || strings.TrimSpace(header.Kind) != "collection" {
				return summary, fmt.Errorf("%w: the first line must be a collection header", ErrInvalidArgument)
			}
			if header.AppliedModelHash != "" && header.AppliedModelHash != modelHash {
				return summary, fmt.Errorf("%w: the exported model does not match the applied model of this project", ErrModelMismatch)
			}
			if header.CollectionID != "" && header.CollectionID != collection.ID {
				return summary, fmt.Errorf("%w: the export targets a different Collection", ErrInvalidArgument)
			}
			index++
			continue
		}
		if index > maximumImportRecords {
			return summary, fmt.Errorf("%w: a single import accepts at most %d Records", ErrInvalidArgument, maximumImportRecords)
		}
		var payload ImportLine
		if err := json.Unmarshal([]byte(line), &payload); err != nil {
			summary.Failed++
			summary.Results = append(summary.Results, ImportResult{Index: index, Status: "failed", Code: "INVALID_ARGUMENT"})
			index++
			continue
		}
		values := payload.Values
		if values == nil {
			summary.Failed++
			summary.Results = append(summary.Results, ImportResult{Index: index, Status: "failed", Code: "MISSING_VALUES"})
			index++
			continue
		}
		record, err := source.Create(ctx, collection.ID, values)
		if err != nil {
			summary.Failed++
			summary.Results = append(summary.Results, ImportResult{Index: index, Status: "failed", Code: importErrorCode(err)})
			index++
			continue
		}
		summary.Created++
		summary.Results = append(summary.Results, ImportResult{Index: index, Status: "created", RecordID: record.ID})
		index++
	}
	if err := scanner.Err(); err != nil {
		return summary, fmt.Errorf("%w: read import stream: %v", ErrInvalidArgument, err)
	}
	if index == 0 {
		return summary, fmt.Errorf("%w: the import stream is empty", ErrInvalidArgument)
	}
	return summary, nil
}

func importErrorCode(err error) string {
	var recordValueError *backendmodel.RecordValueError
	switch {
	case errors.As(err, &recordValueError):
		return "VALIDATION_FAILED"
	case errors.Is(err, backendmodel.ErrInvalidArgument):
		return "VALIDATION_FAILED"
	case errors.Is(err, backendmodel.ErrConflict):
		return "CONFLICT"
	case errors.Is(err, backendmodel.ErrNotFound):
		return "NOT_FOUND"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return "CANCELLED"
	default:
		return "INTERNAL_ERROR"
	}
}

// ContractCollection 是 Typed Application API Contract 中的一个 Collection。
type ContractCollection struct {
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	Type        string              `json:"type"`
	SchemaVersion int               `json:"schemaVersion"`
	Fields      []canonicalField    `json:"fields"`
	Endpoints   []string            `json:"endpoints"`
	AccessRules []ContractAccessRule `json:"accessRules"`
}

// ContractAccessRule 是 Applied Access Rule 的摘要。
type ContractAccessRule struct {
	Operation string `json:"operation"`
	Mode      string `json:"mode"`
}

// ApplicationAPIContract 是 Typed Application API Contract。
type ApplicationAPIContract struct {
	Version     string               `json:"version"`
	ContentHash string               `json:"contentHash"`
	APIBasePath string               `json:"apiBasePath"`
	Collections []ContractCollection `json:"collections"`
}

// RuleSummarySource 提供某个 Collection 已应用的 Access Rule 摘要。
type RuleSummarySource interface {
	AppliedRuleSummary(ctx context.Context, collectionID string) ([]ContractAccessRule, error)
}

// BuildContract 由 Applied Model 生成 Typed Application API Contract。
func (service *Service) BuildContract(ctx context.Context, rules RuleSummarySource) (ApplicationAPIContract, error) {
	collections, err := service.appliedCollections(ctx)
	if err != nil {
		return ApplicationAPIContract{}, err
	}
	entries := contractCollections(collections)
	contract := ApplicationAPIContract{Version: service.version, APIBasePath: "/api/v1", Collections: make([]ContractCollection, 0, len(entries))}
	for index, entry := range entries {
		collection := collections[index]
		endpoints := []string{
			"GET /api/v1/" + entry.Name,
			"POST /api/v1/" + entry.Name,
			"GET /api/v1/" + entry.Name + "/{recordId}",
			"PATCH /api/v1/" + entry.Name + "/{recordId}",
			"DELETE /api/v1/" + entry.Name + "/{recordId}",
		}
		if collection.Type == backendmodel.CollectionTypeAuth {
			endpoints = append(endpoints,
				"POST /api/v1/auth/"+entry.Name+"/register",
				"POST /api/v1/auth/"+entry.Name+"/login",
				"POST /api/v1/auth/"+entry.Name+"/logout",
				"GET /api/v1/auth/"+entry.Name+"/session",
				"POST /api/v1/auth/"+entry.Name+"/password-reset/request",
				"POST /api/v1/auth/"+entry.Name+"/password-reset/confirm",
				"POST /api/v1/auth/"+entry.Name+"/email-verification/request",
				"POST /api/v1/auth/"+entry.Name+"/email-verification/confirm",
			)
		}
		projected := ContractCollection{
			ID: entry.ID, Name: entry.Name, Type: entry.Type, SchemaVersion: entry.Version,
			Fields: entry.Fields, Endpoints: endpoints, AccessRules: []ContractAccessRule{},
		}
		if rules != nil {
			summary, err := rules.AppliedRuleSummary(ctx, entry.ID)
			if err != nil {
				return ApplicationAPIContract{}, err
			}
			if summary != nil {
				projected.AccessRules = summary
			}
		}
		contract.Collections = append(contract.Collections, projected)
	}
	body, err := json.Marshal(struct {
		Version     string               `json:"version"`
		APIBasePath string               `json:"apiBasePath"`
		Collections []ContractCollection `json:"collections"`
	}{Version: contract.Version, APIBasePath: contract.APIBasePath, Collections: contract.Collections})
	if err != nil {
		return ApplicationAPIContract{}, fmt.Errorf("%w: encode contract: %v", ErrStorage, err)
	}
	sum := sha256.Sum256(body)
	contract.ContentHash = hex.EncodeToString(sum[:])
	return contract, nil
}