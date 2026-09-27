package extensions

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestHookInvokerBeforeReceivesOnlyFrozenJSONAndSafeAPI(t *testing.T) {
	code := compileHookForTest(t, `export function beforeCreate(context) {
		return {
			action: "allow",
			value: context.values.name,
			version: modelry.apiVersion,
			secrets: typeof modelry.secrets,
			http: typeof modelry.http,
			date: typeof Date,
			random: typeof Math.random,
			eval: typeof eval,
			function: typeof Function,
			promise: typeof Promise,
			frozen: Object.isFrozen(context) && Object.isFrozen(context.values)
		};
	}`)
	lookupCalled := false
	httpCalled := false
	got, err := (HookInvoker{}).Invoke(context.Background(), Invocation{
		Code:    code,
		Phase:   "beforeCreate",
		Context: json.RawMessage(`{"values":{"name":"Ada"}}`),
		SecretLookup: func(context.Context, string) (string, error) {
			lookupCalled = true
			return "secret", nil
		},
		HTTPRequest: func(context.Context, json.RawMessage) (json.RawMessage, error) {
			httpCalled = true
			return json.RawMessage(`{}`), nil
		},
	})
	if err != nil {
		t.Fatalf("Invoke() error = %v", err)
	}
	if lookupCalled || httpCalled {
		t.Fatalf("before capability callbacks called: secret=%t http=%t", lookupCalled, httpCalled)
	}
	var result map[string]any
	if err := json.Unmarshal(got, &result); err != nil {
		t.Fatalf("Invoke() output is not JSON: %v", err)
	}
	want := map[string]any{
		"action": "allow", "value": "Ada", "version": "modelry.extension/v1",
		"secrets": "undefined", "http": "undefined", "date": "undefined",
		"random": "undefined", "eval": "undefined", "function": "undefined",
		"promise": "undefined", "frozen": true,
	}
	for key, value := range want {
		if result[key] != value {
			t.Errorf("result[%q] = %#v, want %#v", key, result[key], value)
		}
	}
}

func TestHookInvokerAfterExposesOnlyInjectedCallbacks(t *testing.T) {
	code := compileHookForTest(t, `export function afterCommitCreate(context) {
		const key = modelry.secrets.get("MAIL_KEY");
		const result = modelry.http.request({ origin: "https://api.example.test", path: "/send", method: "POST", body: key });
		if (context.eventId !== "evt_1" || result.status !== 202 || result.body !== "accepted") throw new Error("callback failed");
	}`)
	secretCalls := 0
	httpCalls := 0
	got, err := (HookInvoker{}).Invoke(context.Background(), Invocation{
		Code:    code,
		Phase:   "afterCommitCreate",
		Context: json.RawMessage(`{"eventId":"evt_1"}`),
		SecretLookup: func(_ context.Context, alias string) (string, error) {
			secretCalls++
			if alias != "MAIL_KEY" {
				t.Fatalf("Secret alias = %q, want MAIL_KEY", alias)
			}
			return "write-only-secret", nil
		},
		HTTPRequest: func(_ context.Context, request json.RawMessage) (json.RawMessage, error) {
			httpCalls++
			var gotRequest map[string]any
			if err := json.Unmarshal(request, &gotRequest); err != nil {
				t.Fatalf("HTTPRequest got invalid JSON: %v", err)
			}
			if gotRequest["body"] != "write-only-secret" {
				t.Fatalf("request body = %#v", gotRequest["body"])
			}
			return json.RawMessage(`{"status":202,"headers":{},"body":"accepted"}`), nil
		},
	})
	if err != nil {
		t.Fatalf("Invoke() error = %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("after Hook output = %s, want nil", got)
	}
	if secretCalls != 1 || httpCalls != 1 {
		t.Fatalf("capability calls: secret=%d http=%d, want one each", secretCalls, httpCalls)
	}
}

func TestHookInvokerMapsGuestErrorsAndPromisesToSafeErrors(t *testing.T) {
	tests := []struct {
		name    string
		source  string
		want    error
		private string
	}{
		{name: "throw", source: `export function beforeCreate() { throw new Error("guest-private-sentinel"); }`, want: ErrExecutionFailed, private: "guest-private-sentinel"},
		{name: "async declaration", source: `export async function beforeCreate() { return { action: "allow" }; }`, want: ErrAsyncResult},
		{name: "promise result", source: `export function beforeCreate() { return (async () => ({ action: "allow" }))(); }`, want: ErrAsyncResult},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := (HookInvoker{}).Invoke(context.Background(), Invocation{
				Code: compileHookForTest(t, test.source), Phase: "beforeCreate", Context: json.RawMessage(`{}`),
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("Invoke() error = %v, want %v", err, test.want)
			}
			if test.private != "" && strings.Contains(err.Error(), test.private) {
				t.Fatalf("Invoke() leaked Guest error text: %v", err)
			}
		})
	}
}

func TestHookInvokerEnforcesInputAndOutputLimits(t *testing.T) {
	invoker := HookInvoker{}
	code := compileHookForTest(t, `export function beforeCreate() { return { action: "allow", text: "x".repeat(1 << 20) }; }`)
	if _, err := invoker.Invoke(context.Background(), Invocation{Code: code, Phase: "beforeCreate", Context: json.RawMessage(`{}`)}); !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("oversize output error = %v, want ErrBudgetExceeded", err)
	}

	largeContext := json.RawMessage(`{"data":"` + strings.Repeat("x", maximumHookInputBytes) + `"}`)
	if _, err := invoker.Invoke(context.Background(), Invocation{Code: compileHookForTest(t, `export function beforeCreate() { return { action: "allow" }; }`), Phase: "beforeCreate", Context: largeContext}); !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("oversize input error = %v, want ErrBudgetExceeded", err)
	}

	afterCode := compileHookForTest(t, `export function afterCommitCreate() { return "x".repeat(1 << 20); }`)
	if _, err := invoker.Invoke(context.Background(), Invocation{Code: afterCode, Phase: "afterCommitCreate", Context: json.RawMessage(`{}`)}); !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("oversize after output error = %v, want ErrBudgetExceeded", err)
	}
}

func TestHookInvokerEnforcesWallClockCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 300_000_000)
	defer cancel()
	_, err := (HookInvoker{}).Invoke(ctx, Invocation{
		Code:  compileHookForTest(t, `export function beforeCreate() { while (true) {} }`),
		Phase: "beforeCreate", Context: json.RawMessage(`{}`),
	})
	if !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("Invoke() error = %v, want ErrBudgetExceeded", err)
	}
}

func TestHookInvokerRejectsInvalidInvocationWithoutGuestDetails(t *testing.T) {
	_, err := (HookInvoker{}).Invoke(context.Background(), Invocation{
		Code: "guest-private-source", Phase: "beforeCreate", Context: json.RawMessage(`not json`),
	})
	if !errors.Is(err, ErrInvalidInvocation) {
		t.Fatalf("Invoke() error = %v, want ErrInvalidInvocation", err)
	}
	if strings.Contains(err.Error(), "guest-private") {
		t.Fatalf("Invoke() leaked source: %v", err)
	}
}

func compileHookForTest(t *testing.T, source string) string {
	t.Helper()
	compiled, err := CompileSource(LanguageJavaScript, source)
	if err != nil {
		t.Fatalf("CompileSource() error = %v", err)
	}
	return compiled
}
