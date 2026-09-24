package records

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
)

type PolicyDeniedError struct {
	Decision authorization.Decision
}

func (err *PolicyDeniedError) Error() string {
	if err.Decision.Message != "" {
		return err.Decision.Message
	}
	return "Access Rule denied this operation"
}

func (err *PolicyDeniedError) Unwrap() error { return ErrForbidden }

// ErrPolicyEvaluation 表示读取或执行已应用规则失败；不能把它解释为匿名或允许。
var ErrPolicyEvaluation = errors.New("Access Rule evaluation failed")

// AuthenticateApplicationRequest 为 Application API 解析 Bearer Session。
// 未提供凭据时使用匿名身份；已提供但无效的凭据不会降级为匿名身份。
func (service *Service) AuthenticateApplicationRequest(ctx context.Context, request *http.Request) (authorization.Principal, error) {
	value := strings.TrimSpace(request.Header.Get("Authorization"))
	if value == "" {
		return authorization.Principal{Type: authorization.PrincipalAnonymous}, nil
	}
	parts := strings.Fields(value)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return authorization.Principal{}, ErrUnauthenticated
	}
	if service.sessions == nil {
		return authorization.Principal{}, ErrUnauthenticated
	}
	principal, err := service.sessions.AuthenticateSession(ctx, parts[1])
	if err != nil {
		return authorization.Principal{}, fmt.Errorf("%w: application session is invalid", ErrUnauthenticated)
	}
	if principal.Type == "" || principal.Type == authorization.PrincipalAnonymous || principal.ID == "" {
		return authorization.Principal{}, ErrUnauthenticated
	}
	return principal, nil
}

func (service *Service) authorize(ctx context.Context, collectionID string, operation authorization.Operation, principal authorization.Principal, record *authorization.Record) error {
	if service.evaluator == nil {
		return &PolicyDeniedError{Decision: authorization.Decision{Code: "POLICY_DENIED", Message: "Access Rules are unavailable; this operation is denied"}}
	}
	decision, err := service.evaluator.Evaluate(ctx, collectionID, operation, principal, record)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrPolicyEvaluation, err)
	}
	if !decision.Allowed {
		if decision.Code == "" {
			decision.Code = "POLICY_DENIED"
		}
		return &PolicyDeniedError{Decision: decision}
	}
	return nil
}

func authorizedRecord(record Record) *authorization.Record {
	return &authorization.Record{ID: record.ID, Values: record.Values}
}

func (service *Service) ListApplication(ctx context.Context, collectionID string, options ListOptions, principal authorization.Principal) (Page, error) {
	if err := service.authorize(ctx, collectionID, authorization.OperationList, principal, nil); err != nil {
		return Page{}, err
	}
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return Page{}, err
	}
	limit := options.Limit
	if limit == 0 {
		limit = defaultLimit
	}
	if limit < 1 || limit > maximumLimit {
		return Page{}, fmt.Errorf("%w: limit must be between 1 and %d", ErrInvalidArgument, maximumLimit)
	}
	sorts, err := parseSort(model, options.Sort)
	if err != nil {
		return Page{}, err
	}
	visible := make([]Record, 0, limit+1)
	rawOptions := options
	rawOptions.Limit = maximumLimit
	for {
		page, err := service.List(ctx, collectionID, rawOptions)
		if err != nil {
			return Page{}, err
		}
		for _, record := range page.Data {
			decisionErr := service.authorize(ctx, collectionID, authorization.OperationList, principal, authorizedRecord(record))
			if decisionErr != nil && !errors.Is(decisionErr, ErrForbidden) {
				return Page{}, decisionErr
			}
			if decisionErr == nil {
				visible = append(visible, record)
				if len(visible) > limit {
					returned := visible[:limit]
					cursor, err := encodeListCursor(collectionID, sorts, cursorValues(returned[len(returned)-1], sorts))
					if err != nil {
						return Page{}, err
					}
					return Page{Data: returned, NextCursor: cursor}, nil
				}
			}
		}
		if page.NextCursor == "" {
			return Page{Data: visible}, nil
		}
		rawOptions.Cursor = page.NextCursor
	}
}

func (service *Service) GetApplication(ctx context.Context, collectionID, recordID string, principal authorization.Principal) (Record, error) {
	record, err := service.Get(ctx, collectionID, recordID)
	if err != nil {
		return Record{}, err
	}
	if err := service.authorize(ctx, collectionID, authorization.OperationView, principal, authorizedRecord(record)); err != nil {
		return Record{}, err
	}
	return record, nil
}

func (service *Service) OpenFileApplication(ctx context.Context, collectionID, recordID, fieldName string, principal authorization.Principal) (io.ReadCloser, FileInfo, error) {
	record, err := service.GetApplication(ctx, collectionID, recordID, principal)
	if err != nil {
		return nil, FileInfo{}, err
	}
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return nil, FileInfo{}, err
	}
	field, ok := model.byName[fieldName]
	if !ok || field.Type != backendmodel.FieldTypeFile {
		return nil, FileInfo{}, ErrNotFound
	}
	key, ok := record.Values[fieldName].(string)
	if !ok || !objectKeyPattern.MatchString(key) || service.files == nil {
		return nil, FileInfo{}, ErrFileNotFound
	}
	file, err := service.files.openObject(key)
	if err != nil {
		return nil, FileInfo{}, fmt.Errorf("%w: stored object is missing or unavailable", ErrFileNotFound)
	}
	buffer := make([]byte, 512)
	n, readErr := file.Read(buffer)
	if readErr != nil && readErr != io.EOF {
		_ = file.Close()
		return nil, FileInfo{}, fmt.Errorf("read stored object metadata: %w", readErr)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, FileInfo{}, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, FileInfo{}, err
	}
	contentType, _, _ := mime.ParseMediaType(http.DetectContentType(buffer[:n]))
	return file, FileInfo{ContentType: contentType, Size: info.Size()}, nil
}

func (service *Service) CreateApplication(ctx context.Context, collectionID string, values map[string]any, principal authorization.Principal) (Record, error) {
	model, err := service.loadModel(ctx, collectionID)
	if err != nil {
		return Record{}, err
	}
	validated, err := service.validateWriteValues(model, values)
	if err != nil {
		return Record{}, err
	}
	if err := service.authorize(ctx, collectionID, authorization.OperationCreate, principal, &authorization.Record{Values: validated}); err != nil {
		return Record{}, err
	}
	return service.create(ctx, collectionID, values, true)
}

func (service *Service) UpdateApplication(ctx context.Context, collectionID, recordID string, values map[string]any, principal authorization.Principal) (Record, error) {
	previous, err := service.Get(ctx, collectionID, recordID)
	if err != nil {
		return Record{}, err
	}
	if err := service.authorize(ctx, collectionID, authorization.OperationUpdate, principal, authorizedRecord(previous)); err != nil {
		return Record{}, err
	}
	return service.update(ctx, collectionID, recordID, values, true)
}

func (service *Service) DeleteApplication(ctx context.Context, collectionID, recordID string, principal authorization.Principal) error {
	record, err := service.Get(ctx, collectionID, recordID)
	if err != nil {
		return err
	}
	if err := service.authorize(ctx, collectionID, authorization.OperationDelete, principal, authorizedRecord(record)); err != nil {
		return err
	}
	return service.delete(ctx, collectionID, recordID, true)
}

func (service *Service) validateWriteValues(model appliedModel, values map[string]any) (map[string]any, error) {
	validated, err := backendmodel.ValidateRecordValues(model.collection, values)
	if err != nil {
		return nil, mapModelError(err)
	}
	fillOptionalValues(model.collection, validated)
	return validated, nil
}
