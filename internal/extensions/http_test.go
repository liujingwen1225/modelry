package extensions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
)

func TestAdminHTTPContractAndSecretWriteOnlyResponses(t *testing.T) {
	fixture := newExtensionFixture(t, nil)
	collection, err := fixture.models.CreateCollection(context.Background(), backendmodel.CreateCollectionInput{Name: "Profiles", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewModule(fixture.service).RegisterRoutes(mux)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		return response
	}

	created := request(http.MethodPost, "/admin/api/v1/extensions", `{"name":"Normalize","language":"javascript","source":"export function beforeCreate(){return {action:'allow'};}"}`)
	if created.Code != http.StatusCreated || strings.Contains(created.Body.String(), "createdAt\":\"0001") {
		t.Fatalf("create Extension response = %d %s", created.Code, created.Body.String())
	}
	var envelope struct {
		Data Detail `json:"data"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &envelope); err != nil || envelope.Data.ID == "" || envelope.Data.CreatedAt.IsZero() {
		t.Fatalf("Extension detail response did not match contract: %+v, %v", envelope, err)
	}
	bad := request(http.MethodPost, "/admin/api/v1/extensions", `{"name":"Bad","language":"javascript","source":"export function beforeCreate(){}","secret":"unexpected"}`)
	if bad.Code != http.StatusBadRequest || strings.Contains(bad.Body.String(), "unexpected") {
		t.Fatalf("unknown Extension input field was not rejected safely: %d %s", bad.Code, bad.Body.String())
	}
	updated := request(http.MethodPut, "/admin/api/v1/extensions/"+envelope.Data.ID, `{"name":"Normalize","language":"javascript","source":"export function beforeCreate(){return {action:'allow'};}","bindings":[{"collectionId":"`+collection.ID+`","operation":"create","phase":"before"}],"secretBindings":[],"allowedOrigins":[]}`)
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), collection.ID) {
		t.Fatalf("replace Extension response = %d %s", updated.Code, updated.Body.String())
	}
	enabled := request(http.MethodPost, "/admin/api/v1/extensions/"+envelope.Data.ID+"/enable", "")
	if enabled.Code != http.StatusOK || !strings.Contains(enabled.Body.String(), `"enabled":true`) {
		t.Fatalf("enable Extension response = %d %s", enabled.Code, enabled.Body.String())
	}
	secretValue := "admin-api-secret-must-not-return"
	secret := request(http.MethodPost, "/admin/api/v1/secrets", `{"name":"Mail provider","value":"`+secretValue+`"}`)
	if secret.Code != http.StatusCreated || strings.Contains(secret.Body.String(), secretValue) {
		t.Fatalf("write-only Secret create response leaked the value: %d %s", secret.Code, secret.Body.String())
	}
	var secretEnvelope struct {
		Data SecretMetadata `json:"data"`
	}
	if err := json.Unmarshal(secret.Body.Bytes(), &secretEnvelope); err != nil || secretEnvelope.Data.ID == "" || !secretEnvelope.Data.Configured {
		t.Fatalf("Secret metadata response did not match contract: %+v, %v", secretEnvelope, err)
	}
	listed := request(http.MethodGet, "/admin/api/v1/secrets", "")
	if listed.Code != http.StatusOK || strings.Contains(listed.Body.String(), secretValue) || strings.Contains(listed.Body.String(), "value_cipher") {
		t.Fatalf("Secret list response was unsafe: %d %s", listed.Code, listed.Body.String())
	}
	replaced := request(http.MethodPut, "/admin/api/v1/secrets/"+secretEnvelope.Data.ID+"/value", `{"value":"replacement-secret"}`)
	if replaced.Code != http.StatusOK || strings.Contains(replaced.Body.String(), "replacement-secret") {
		t.Fatalf("Secret replacement response leaked the new value: %d %s", replaced.Code, replaced.Body.String())
	}
	deleted := request(http.MethodDelete, "/admin/api/v1/secrets/"+secretEnvelope.Data.ID, "")
	if deleted.Code != http.StatusNoContent || deleted.Body.Len() != 0 {
		t.Fatalf("delete Secret response = %d %q", deleted.Code, deleted.Body.String())
	}
}

func TestAdminHTTPValidatesRunPaginationAndHidesUnknownResources(t *testing.T) {
	fixture := newExtensionFixture(t, nil)
	mux := http.NewServeMux()
	NewModule(fixture.service).RegisterRoutes(mux)
	invalid := httptest.NewRecorder()
	mux.ServeHTTP(invalid, httptest.NewRequest(http.MethodGet, "/admin/api/v1/extensions/ext_unknown/runs?limit=101", nil))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid Hook Run limit status = %d body=%s", invalid.Code, invalid.Body.String())
	}
	missing := httptest.NewRecorder()
	mux.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/admin/api/v1/extensions/ext_unknown", nil))
	if missing.Code != http.StatusNotFound || strings.Contains(missing.Body.String(), "sql") {
		t.Fatalf("unknown Extension response was not a safe 404: %d %s", missing.Code, missing.Body.String())
	}
}

func TestAdminHTTPValidationAndBindingConflictIncludeSafeDetails(t *testing.T) {
	fixture := newExtensionFixture(t, nil)
	collection, err := fixture.models.CreateCollection(context.Background(), backendmodel.CreateCollectionInput{Name: "Profiles", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewModule(fixture.service).RegisterRoutes(mux)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		return response
	}
	invalidSource := request(http.MethodPost, "/admin/api/v1/extensions", `{"name":"Bad","language":"javascript","source":"export function beforeCreate( {"}`)
	var validation struct {
		Error struct {
			Code    string `json:"code"`
			Details struct {
				Violations []ValidationViolation `json:"violations"`
			} `json:"details"`
		} `json:"error"`
	}
	if invalidSource.Code != http.StatusUnprocessableEntity || json.Unmarshal(invalidSource.Body.Bytes(), &validation) != nil || validation.Error.Code != "VALIDATION_FAILED" || len(validation.Error.Details.Violations) != 1 || validation.Error.Details.Violations[0].Path != "/source" || validation.Error.Details.Violations[0].Code != "invalidSource" {
		t.Fatalf("invalid source response lacks safe field detail: %d %s", invalidSource.Code, invalidSource.Body.String())
	}
	create := func(name string) Detail {
		t.Helper()
		response := request(http.MethodPost, "/admin/api/v1/extensions", `{"name":"`+name+`","language":"javascript","source":"export function beforeCreate(){return {action:'allow'};}"}`)
		if response.Code != http.StatusCreated {
			t.Fatalf("create Extension %q: %d %s", name, response.Code, response.Body.String())
		}
		var body struct {
			Data Detail `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Data
	}
	configure := func(extension Detail) {
		t.Helper()
		body := `{"name":"` + extension.Name + `","language":"javascript","source":"export function beforeCreate(){return {action:'allow'};}","bindings":[{"collectionId":"` + collection.ID + `","operation":"create","phase":"before"}],"secretBindings":[],"allowedOrigins":[]}`
		response := request(http.MethodPut, "/admin/api/v1/extensions/"+extension.ID, body)
		if response.Code != http.StatusOK {
			t.Fatalf("configure Extension %q: %d %s", extension.Name, response.Code, response.Body.String())
		}
	}
	first, second := create("First"), create("Second")
	configure(first)
	configure(second)
	if response := request(http.MethodPost, "/admin/api/v1/extensions/"+first.ID+"/enable", ""); response.Code != http.StatusOK {
		t.Fatalf("enable first Extension: %d %s", response.Code, response.Body.String())
	}
	conflict := request(http.MethodPost, "/admin/api/v1/extensions/"+second.ID+"/enable", "")
	var conflictBody struct {
		Error struct {
			Code    string         `json:"code"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if conflict.Code != http.StatusConflict || json.Unmarshal(conflict.Body.Bytes(), &conflictBody) != nil || conflictBody.Error.Code != "BINDING_CONFLICT" || conflictBody.Error.Details["collectionId"] != collection.ID || conflictBody.Error.Details["operation"] != string(OperationCreate) || conflictBody.Error.Details["phase"] != string(PhaseBefore) {
		t.Fatalf("binding conflict response lacks slot details: %d %s", conflict.Code, conflict.Body.String())
	}
}
