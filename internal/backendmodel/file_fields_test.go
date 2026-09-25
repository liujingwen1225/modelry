package backendmodel

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestAppliedFileConstraintsDefaultsAndOverrides(t *testing.T) {
	field := Field{Name: "attachment", Type: FieldTypeFile}
	constraints, err := AppliedFileConstraints(field)
	if err != nil {
		t.Fatal(err)
	}
	if constraints.MaxBytes != DefaultFileBytes || constraints.MaxFiles != DefaultFileCount || len(constraints.AllowedMIMETypes) != len(DefaultFileMIMETypes()) {
		t.Fatalf("default constraints = %+v", constraints)
	}
	field.Validation = json.RawMessage(`{"maxBytes":1024,"maxFiles":2,"allowedMimeTypes":["Text/Plain","text/plain","image/*"]}`)
	constraints, err = AppliedFileConstraints(field)
	if err != nil {
		t.Fatal(err)
	}
	if constraints.MaxBytes != 1024 || constraints.MaxFiles != 2 {
		t.Fatalf("overridden constraints = %+v", constraints)
	}
	if strings.Join(constraints.AllowedMIMETypes, ",") != "text/plain,image/*" {
		t.Fatalf("normalized MIME types = %v", constraints.AllowedMIMETypes)
	}
}

func TestAppliedFileConstraintsRejectsInvalidDeclarations(t *testing.T) {
	cases := map[string]string{
		"zero bytes":        `{"maxBytes":0}`,
		"too many bytes":    `{"maxBytes":134217729}`,
		"zero files":        `{"maxFiles":0}`,
		"too many files":    `{"maxFiles":33}`,
		"empty MIME list":   `{"allowedMimeTypes":[]}`,
		"invalid MIME":      `{"allowedMimeTypes":["not a mime"]}`,
		"unknown key":       `{"maxSize":10}`,
		"invalid JSON shape": `["nope"]`,
	}
	for name, validation := range cases {
		field := Field{Name: "attachment", Type: FieldTypeFiles, Validation: json.RawMessage(validation)}
		if _, err := AppliedFileConstraints(field); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("%s: error = %v, want ErrInvalidArgument", name, err)
		}
	}
}

func TestValidateFieldRejectsUnsupportedFileConstraintCombinations(t *testing.T) {
	single := Field{Name: "attachment", Type: FieldTypeFile, Validation: json.RawMessage(`{"maxFiles":2}`)}
	if err := validateField(single); !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "maxFiles") {
		t.Fatalf("single file with maxFiles error = %v", err)
	}
	unique := Field{Name: "attachments", Type: FieldTypeFiles, Unique: true}
	if err := validateField(unique); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unique files Field error = %v", err)
	}
	valid := Field{Name: "attachments", Type: FieldTypeFiles, Validation: json.RawMessage(`{"maxFiles":4}`)}
	if err := validateField(valid); err != nil {
		t.Fatalf("valid files Field error = %v", err)
	}
}

func TestValidateFieldValueForFiles(t *testing.T) {
	field := Field{Name: "attachments", Type: FieldTypeFiles}
	valid := []any{"obj_0123456789abcdef0123456789abcdef"}
	if err := validateFieldValue(field, valid, true); err != nil {
		t.Fatalf("valid files value error = %v", err)
	}
	if err := validateFieldValue(field, "obj_0123456789abcdef0123456789abcdef", true); err == nil {
		t.Fatal("files Field accepted a single string")
	}
	if err := validateFieldValue(field, []any{"obj_0123456789abcdef0123456789abcdef", 42}, true); err == nil {
		t.Fatal("files Field accepted a non-string entry")
	}
	tooMany := make([]any, MaximumFileCount+1)
	for index := range tooMany {
		tooMany[index] = "obj_0123456789abcdef0123456789abcdef"
	}
	if err := validateFieldValue(field, tooMany, true); err == nil {
		t.Fatal("files Field accepted more than the hard limit")
	}
	required := Field{Name: "attachments", Type: FieldTypeFiles, Required: true}
	if err := validateFieldValue(required, nil, true); err == nil {
		t.Fatal("required files Field accepted a missing value")
	}
}

func TestMIMEHelpers(t *testing.T) {
	allowed := []string{"text/plain", "image/*"}
	if !MIMEAllowed("image/png", allowed) || MIMEAllowed("application/pdf", allowed) {
		t.Fatalf("MIMEAllowed mismatch")
	}
	if !MIMESubset("image/png", allowed) || MIMESubset("application/pdf", allowed) {
		t.Fatalf("MIMESubset mismatch")
	}
	if MIMESubset("image/*", allowed) != true {
		t.Fatalf("wildcard subset must match an identical wildcard")
	}
}
