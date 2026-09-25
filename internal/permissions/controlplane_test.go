package permissions

import (
	"net/http"
	"testing"
)

func TestControlPlaneOperationMapsAdministratorsAndMail(t *testing.T) {
	cases := []struct {
		method string
		path   string
		want   Operation
	}{
		{http.MethodGet, "/admin/api/v1/administrators", OperationAdministratorsRead},
		{http.MethodPost, "/admin/api/v1/administrators", OperationAdministratorsManage},
		{http.MethodGet, "/admin/api/v1/administrators/adm_0123456789abcdef0123456789abcdef", OperationAdministratorsRead},
		{http.MethodPatch, "/admin/api/v1/administrators/adm_0123456789abcdef0123456789abcdef", OperationAdministratorsManage},
		{http.MethodDelete, "/admin/api/v1/administrators/adm_0123456789abcdef0123456789abcdef", OperationAdministratorsManage},
		{http.MethodPost, "/admin/api/v1/administrators/adm_0123456789abcdef0123456789abcdef/enable", OperationAdministratorsManage},
		{http.MethodPost, "/admin/api/v1/administrators/adm_0123456789abcdef0123456789abcdef/disable", OperationAdministratorsManage},
		{http.MethodPost, "/admin/api/v1/administrators/adm_0123456789abcdef0123456789abcdef/password", OperationAdministratorsManage},
		{http.MethodGet, "/admin/api/v1/administrators/adm_0123456789abcdef0123456789abcdef/sessions", OperationSessionsRead},
		{http.MethodPost, "/admin/api/v1/administrators/adm_0123456789abcdef0123456789abcdef/sessions/revoke-all", OperationSessionsRevoke},
		{http.MethodGet, "/admin/api/v1/mail", OperationMailRead},
		{http.MethodPut, "/admin/api/v1/mail", OperationMailManage},
		{http.MethodPost, "/admin/api/v1/mail/test", OperationMailManage},
		{http.MethodGet, "/admin/api/v1/mail/deliveries", OperationMailRead},
		{http.MethodPost, "/admin/api/v1/mail/deliveries/mail_0123456789abcdef0123456789abcdef/retry", OperationMailManage},
	}
	for _, testCase := range cases {
		got, ok := ControlPlaneOperation(testCase.method, testCase.path)
		if !ok || got != testCase.want {
			t.Errorf("ControlPlaneOperation(%s %s) = %q, %t; want %q", testCase.method, testCase.path, got, ok, testCase.want)
		}
	}
	against := []struct {
		method string
		path   string
	}{
		{http.MethodDelete, "/admin/api/v1/mail"},
		{http.MethodPut, "/admin/api/v1/administrators"},
		{http.MethodGet, "/admin/api/v1/administrators/adm_x/sessions/revoke-all"},
		{http.MethodPost, "/admin/api/v1/mail/deliveries"},
	}
	for _, testCase := range against {
		if _, ok := ControlPlaneOperation(testCase.method, testCase.path); ok {
			t.Errorf("ControlPlaneOperation(%s %s) should be unmapped", testCase.method, testCase.path)
		}
	}
}

func TestGrantAllowsAdministratorAndMailOperations(t *testing.T) {
	readOnly := Grant{Preset: PresetReadOnly}
	if !GrantAllows(readOnly, OperationAdministratorsRead) || !GrantAllows(readOnly, OperationMailRead) {
		t.Fatal("Read only Permission must cover administrator and mail reads")
	}
	if GrantAllows(readOnly, OperationAdministratorsManage) || GrantAllows(readOnly, OperationMailManage) {
		t.Fatal("Read only Permission must not cover administrator or mail management")
	}
	full := Grant{Preset: PresetFullAccess}
	for _, operation := range AllOperations() {
		if !GrantAllows(full, operation) {
			t.Fatalf("Full access must cover %s", operation)
		}
	}
	custom, err := NormalizeGrant(PresetCustom, CustomPermissionVersion, []Operation{OperationMailManage, OperationAdministratorsRead})
	if err != nil {
		t.Fatal(err)
	}
	if !GrantAllows(custom, OperationMailManage) || GrantAllows(custom, OperationMailRead) {
		t.Fatalf("custom grant evaluation mismatch: %+v", custom)
	}
	if _, err := NormalizeGrant(PresetCustom, CustomPermissionVersion, []Operation{Operation("oauth.manage")}); err == nil {
		t.Fatal("unknown operation must be rejected")
	}
}
