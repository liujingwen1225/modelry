package records

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/recordevents"
)

type recordResponse struct {
	Data Record `json:"data"`
}

type recordListResponse struct {
	Data       []Record `json:"data"`
	NextCursor string   `json:"nextCursor,omitempty"`
}

type recordWriteRequest struct {
	Values map[string]any `json:"values"`
}

type fileUploadResponse struct {
	Data UploadedFile `json:"data"`
}

// RegisterRoutes 注册 Admin Records CRUD 路由。调用方应在其外层套用 Admin Owner Middleware。
func (service *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}/records", service.handleList)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/records", service.handleCreate)
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}/records/{recordId}", service.handleGet)
	mux.HandleFunc("PATCH /admin/api/v1/collections/{collectionId}/records/{recordId}", service.handleUpdate)
	mux.HandleFunc("DELETE /admin/api/v1/collections/{collectionId}/records/{recordId}", service.handleDelete)
	mux.HandleFunc("POST /admin/api/v1/collections/{collectionId}/files", service.handleFileUpload)
	mux.HandleFunc("GET /admin/api/v1/collections/{collectionId}/records/{recordId}/files/{fieldName}", service.handleFileDownload)
}

func (service *Service) handleList(w http.ResponseWriter, r *http.Request) {
	if _, requested := r.URL.Query()["expand"]; requested {
		writeRecordError(w, r, fmt.Errorf("%w: expand is only supported for single Record reads", ErrInvalidArgument))
		return
	}
	options, err := parseQueryValues(r.URL.Query())
	if err != nil {
		writeRecordError(w, r, err)
		return
	}
	page, err := service.List(r.Context(), r.PathValue("collectionId"), options)
	if err != nil {
		writeRecordError(w, r, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, recordListResponse{Data: page.Data, NextCursor: page.NextCursor})
}

func (service *Service) handleGet(w http.ResponseWriter, r *http.Request) {
	expands, err := ParseExpandQuery(r.URL.Query())
	if err != nil {
		writeRecordError(w, r, err)
		return
	}
	record, err := service.GetExpanded(r.Context(), r.PathValue("collectionId"), r.PathValue("recordId"), expands)
	if err != nil {
		writeRecordError(w, r, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, recordResponse{Data: record})
}

func (service *Service) handleCreate(w http.ResponseWriter, r *http.Request) {
	request, err := decodeRecordWrite(r)
	if err != nil {
		writeRecordError(w, r, err)
		return
	}
	record, err := service.Create(r.Context(), r.PathValue("collectionId"), request.Values)
	if err != nil {
		writeRecordError(w, r, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, recordResponse{Data: record})
}

func (service *Service) handleUpdate(w http.ResponseWriter, r *http.Request) {
	request, err := decodeRecordWrite(r)
	if err != nil {
		writeRecordError(w, r, err)
		return
	}
	record, err := service.Update(r.Context(), r.PathValue("collectionId"), r.PathValue("recordId"), request.Values)
	if err != nil {
		writeRecordError(w, r, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, recordResponse{Data: record})
}

func (service *Service) handleDelete(w http.ResponseWriter, r *http.Request) {
	if err := service.Delete(r.Context(), r.PathValue("collectionId"), r.PathValue("recordId")); err != nil {
		writeRecordError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (service *Service) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	fieldNames := r.URL.Query()["fieldName"]
	if len(fieldNames) != 1 || strings.TrimSpace(fieldNames[0]) == "" {
		writeRecordError(w, r, fmt.Errorf("%w: fieldName query parameter is required exactly once", ErrInvalidArgument))
		return
	}
	defer r.Body.Close()
	upload, err := service.UploadFile(r.Context(), r.PathValue("collectionId"), fieldNames[0], r.Body, FilePolicy{})
	if err != nil {
		writeRecordError(w, r, err)
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusCreated, fileUploadResponse{Data: upload})
}

func (service *Service) handleFileDownload(w http.ResponseWriter, r *http.Request) {
	file, info, err := service.OpenFile(r.Context(), r.PathValue("collectionId"), r.PathValue("recordId"), r.PathValue("fieldName"))
	if err != nil {
		writeRecordError(w, r, err)
		return
	}
	defer file.Close()
	contentType := info.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if parsed, _, err := mime.ParseMediaType(contentType); err == nil {
		contentType = parsed
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size))
	w.Header().Set("Content-Disposition", "attachment")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, file)
}

func decodeRecordWrite(r *http.Request) (recordWriteRequest, error) {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	var request recordWriteRequest
	if err := decoder.Decode(&request); err != nil {
		return recordWriteRequest{}, errors.Join(ErrInvalidArgument, err)
	}
	if request.Values == nil {
		return recordWriteRequest{}, errors.Join(ErrInvalidArgument, errors.New("values are required"))
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return recordWriteRequest{}, errors.Join(ErrInvalidArgument, errors.New("request body must contain one JSON object"))
	}
	return request, nil
}

func writeRecordError(w http.ResponseWriter, r *http.Request, err error) {
	problem := httpapi.APIError{Message: "Record request could not be completed", Details: map[string]any{}}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, recordevents.ErrEventTooLarge):
		status = http.StatusRequestEntityTooLarge
		problem.Code = "PAYLOAD_TOO_LARGE"
		problem.Message = "This Record change exceeds the 1 MiB durable Event limit. Reduce the changed values and retry."
	case errors.Is(err, ErrAuthCollectionWriteRequiresAuthAPI):
		status = http.StatusForbidden
		problem.Code = "AUTH_COLLECTION_WRITE_REQUIRES_AUTH_API"
		problem.Message = "Manage users in an Auth Collection through the Auth User APIs."
		problem.Hint = "Use /admin/api/v1/collections/{collectionId}/users to create users, and the user password and session routes to manage credentials and sessions."
	case errors.Is(err, ErrInvalidArgument), errors.Is(err, backendmodel.ErrInvalidArgument):
		status = http.StatusBadRequest
		problem.Code = "INVALID_ARGUMENT"
		problem.Message = "Record request is invalid"
		var fieldError *backendmodel.RecordValueError
		if errors.As(err, &fieldError) {
			problem.Code = "VALIDATION_FAILED"
			status = http.StatusUnprocessableEntity
			problem.Message = "Record values do not match the Applied Model"
			problem.Details["violations"] = []map[string]string{{"path": fieldError.Field, "code": fieldError.Code, "message": fieldError.Message}}
		}
	case errors.Is(err, ErrUnauthenticated):
		status = http.StatusUnauthorized
		problem.Code = "UNAUTHENTICATED"
		problem.Message = "A valid Application Session is required"
	case errors.Is(err, ErrForbidden):
		status = http.StatusForbidden
		problem.Code = "FORBIDDEN"
		problem.Message = "Access Rules denied this operation"
	case errors.Is(err, ErrNotFound), errors.Is(err, backendmodel.ErrNotFound):
		status = http.StatusNotFound
		problem.Code = "NOT_FOUND"
		problem.Message = "Record or Collection was not found"
	case errors.Is(err, ErrConflict), errors.Is(err, backendmodel.ErrConflict):
		status = http.StatusConflict
		problem.Code = "CONFLICT"
		problem.Message = "Record conflicts with durable data"
	case errors.Is(err, ErrFileStorageUnavailable), errors.Is(err, ErrFileNotFound):
		status = http.StatusServiceUnavailable
		problem.Code = "STORAGE_UNAVAILABLE"
		problem.Message = "Local File Storage is unavailable; check the project storage and retry"
	default:
		// 不向客户端返回原始 SQLite 错误、查询细节或存储路径。
		if strings.Contains(strings.ToLower(err.Error()), "busy") || strings.Contains(strings.ToLower(err.Error()), "locked") {
			status = http.StatusServiceUnavailable
			problem.Code = "STORAGE_BUSY"
			problem.Message = "The project database is busy; retry the operation"
		} else {
			problem.Code = "INTERNAL_ERROR"
		}
	}
	httpapi.WriteAPIError(w, r, status, problem)
}
