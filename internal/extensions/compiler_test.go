package extensions

import (
	"strings"
	"testing"
)

func TestCompileSourceWrapsNamedHookExports(t *testing.T) {
	compiled, err := CompileSource(LanguageTypeScript, `export function beforeCreate(context: { values: Record<string, unknown> }) { return { action: "allow", values: context.values }; }`)
	if err != nil {
		t.Fatalf("CompileSource() error = %v", err)
	}
	if !strings.Contains(compiled, "ModelryExtension") || !strings.Contains(compiled, "beforeCreate") {
		t.Fatalf("compiled source does not expose the Hook exports: %s", compiled)
	}
}

func TestCompileSourceRejectsInvalidAndUnsupportedInput(t *testing.T) {
	tests := []struct {
		name     string
		language Language
		source   string
	}{
		{name: "unknown language", language: "python", source: "export function beforeCreate() {}"},
		{name: "syntax error", language: LanguageJavaScript, source: "export function beforeCreate( {"},
		{name: "static import", language: LanguageJavaScript, source: `import value from "./value.js"; export function beforeCreate() {}`},
		{name: "dynamic import", language: LanguageJavaScript, source: `export function beforeCreate() { return import("qjs:std"); }`},
		{name: "re-export", language: LanguageJavaScript, source: `export { value } from "./value.js";`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := CompileSource(test.language, test.source); err == nil {
				t.Fatal("CompileSource() unexpectedly accepted unsupported input")
			}
		})
	}
}

func TestCompileSourceUsesUTF8ByteLimits(t *testing.T) {
	tooLarge := strings.Repeat("汉", maximumSourceBytes/3+1)
	if _, err := CompileSource(LanguageJavaScript, tooLarge); err == nil {
		t.Fatal("CompileSource() accepted source larger than the UTF-8 byte limit")
	}
}

func TestCompileSourceCapsTransformedOutput(t *testing.T) {
	padding := strings.Repeat("x", maximumSourceBytes-512)
	source := `export const extensionValue = "` + padding + `"; export function beforeCreate() { return { action: extensionValue }; }`
	if len([]byte(source)) > maximumSourceBytes {
		t.Skip("test fixture exceeds the source limit before transformation")
	}
	if _, err := CompileSource(LanguageJavaScript, source); err == nil {
		t.Fatal("CompileSource() accepted transformed output larger than the byte limit")
	}
}
