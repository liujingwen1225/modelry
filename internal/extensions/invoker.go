package extensions

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"
	"unicode/utf8"

	qjsengine "github.com/liujingwen1225/modelry/internal/extensions/qjsengine"
)

const (
	maximumHookInputBytes  = 1 << 20
	maximumHookOutputBytes = 1 << 20
	maximumHTTPInputBytes  = 1 << 20
	maximumSecretBytes     = 16 << 10
	maximumBeforeDuration  = 2 * time.Second
	maximumAfterDuration   = 5 * time.Second
)

var (
	ErrInvalidInvocation     = errors.New("extension invocation is invalid")
	ErrBudgetExceeded        = errors.New("extension invocation exceeded its budget")
	ErrInvocationCancelled   = errors.New("extension invocation was cancelled")
	ErrExecutionFailed       = errors.New("extension execution failed")
	ErrAsyncResult           = errors.New("extension hooks must complete synchronously")
	ErrInvalidOutput         = errors.New("extension output is invalid")
	ErrSecretUnavailable     = errors.New("extension Secret is unavailable")
	ErrExternalRequestFailed = errors.New("extension external request failed")
)

const (
	phaseBeforeCreate      = "beforeCreate"
	phaseBeforeUpdate      = "beforeUpdate"
	phaseBeforeDelete      = "beforeDelete"
	phaseAfterCommitCreate = "afterCommitCreate"
	phaseAfterCommitUpdate = "afterCommitUpdate"
	phaseAfterCommitDelete = "afterCommitDelete"
)

// HookInvoker 为每次同步生命周期调用创建独立且资源受限的 QuickJS 实例。
type HookInvoker struct{}

var _ Invoker = HookInvoker{}

// Invoke 执行编译后 Extension 导出的对应阶段。Before Hook 返回 JSON 结果；提交后 Hook 完成后返回 nil。
func (HookInvoker) Invoke(parent context.Context, invocation Invocation) (output json.RawMessage, err error) {
	if len(invocation.Context) > maximumHookInputBytes {
		return nil, ErrBudgetExceeded
	}
	if parent == nil || !validHookPhase(invocation.Phase) || !validCompiledCode(invocation.Code) || !validHookContext(invocation.Context) {
		return nil, ErrInvalidInvocation
	}
	if err := parent.Err(); err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, ErrInvocationCancelled
		}
		return nil, ErrBudgetExceeded
	}

	duration := maximumBeforeDuration
	if isAfterPhase(invocation.Phase) {
		duration = maximumAfterDuration
	}
	runContext, cancel := context.WithTimeout(parent, duration)
	defer cancel()

	defer func() {
		if recover() != nil {
			output = nil
			err = invocationContextError(parent, runContext)
		}
		if err != nil {
			output = nil
		}
	}()

	runtime, createErr := qjsengine.New(qjsengine.Option{
		Context:      runContext,
		MemoryLimit:  32 << 20,
		MaxStackSize: 1 << 20,
		Stdout:       io.Discard,
		Stderr:       io.Discard,
	})
	if createErr != nil {
		return nil, invocationContextError(parent, runContext)
	}
	defer closeInvocationRuntime(runtime)

	js := runtime.Context()
	if _, evalErr := runtime.Eval("modelry-lockdown.js", qjsengine.Code(lockdownSource(isBeforePhase(invocation.Phase)))); evalErr != nil {
		return nil, invocationContextError(parent, runContext)
	}

	helper, helperErr := runtime.Eval("modelry-host-helpers.js", qjsengine.Code(hostHelpersSource))
	if helperErr != nil || helper == nil || !helper.IsObject() {
		return nil, invocationContextError(parent, runContext)
	}
	defer helper.Free()

	contextValue := js.ParseJSON(string(invocation.Context))
	if js.HasException() {
		_ = js.Exception()
		contextValue.Free()
		return nil, ErrInvalidInvocation
	}
	defer contextValue.Free()

	deepFreeze := helper.GetPropertyStr("deepFreeze")
	if !deepFreeze.IsFunction() {
		deepFreeze.Free()
		return nil, ErrExecutionFailed
	}
	freezeResult, freezeErr := js.Invoke(deepFreeze, js.NewUndefined(), contextValue)
	deepFreeze.Free()
	if freezeErr != nil {
		return nil, ErrExecutionFailed
	}
	if freezeResult != nil {
		freezeResult.Free()
	}

	api, apiErr := makeInvocationAPI(js, helper, invocation, runContext)
	if apiErr != nil {
		return nil, apiErr
	}
	defer api.Free()

	install := helper.GetPropertyStr("install")
	if !install.IsFunction() {
		install.Free()
		return nil, ErrExecutionFailed
	}
	installResult, installErr := js.Invoke(install, js.NewUndefined(), api)
	install.Free()
	if installErr != nil {
		return nil, invocationContextError(parent, runContext)
	}
	if installResult != nil {
		installResult.Free()
	}

	compiledResult, evalErr := runtime.Eval("extension.js", qjsengine.Code(invocation.Code))
	if evalErr != nil {
		return nil, invocationContextError(parent, runContext)
	}
	if compiledResult != nil {
		if compiledResult.IsPromise() {
			compiledResult.Free()
			return nil, ErrAsyncResult
		}
		compiledResult.Free()
	}

	extension := js.Global().GetPropertyStr("ModelryExtension")
	defer extension.Free()
	if !extension.IsObject() {
		return nil, ErrExecutionFailed
	}
	hook := extension.GetPropertyStr(string(invocation.Phase))
	defer hook.Free()
	if !hook.IsFunction() {
		return nil, ErrExecutionFailed
	}

	asyncCheck := helper.GetPropertyStr("isAsync")
	if !asyncCheck.IsFunction() {
		asyncCheck.Free()
		return nil, ErrExecutionFailed
	}
	asyncResult, asyncErr := js.Invoke(asyncCheck, js.NewUndefined(), hook)
	asyncCheck.Free()
	if asyncErr != nil {
		return nil, ErrExecutionFailed
	}
	isAsync := asyncResult.Bool()
	asyncResult.Free()
	if isAsync {
		return nil, ErrAsyncResult
	}

	result, invokeErr := extension.InvokeJS(string(invocation.Phase), contextValue)
	if invokeErr != nil {
		return nil, invocationContextError(parent, runContext)
	}
	if result == nil {
		return nil, ErrInvalidOutput
	}
	defer result.Free()
	if result.IsPromise() {
		return nil, ErrAsyncResult
	}
	if err := runContext.Err(); err != nil {
		return nil, invocationContextError(parent, runContext)
	}
	if isAfterPhase(invocation.Phase) && result.IsUndefined() {
		return nil, nil
	}

	stringify := helper.GetPropertyStr("stringify")
	if !stringify.IsFunction() {
		stringify.Free()
		return nil, ErrExecutionFailed
	}
	serializedValue, stringifyErr := js.Invoke(stringify, js.NewUndefined(), result)
	stringify.Free()
	if stringifyErr != nil || serializedValue == nil || !serializedValue.IsString() {
		if serializedValue != nil {
			serializedValue.Free()
		}
		return nil, ErrInvalidOutput
	}
	serialized := serializedValue.String()
	serializedValue.Free()
	if !utf8.ValidString(serialized) || !json.Valid([]byte(serialized)) {
		return nil, ErrInvalidOutput
	}
	if len([]byte(serialized)) > maximumHookOutputBytes {
		return nil, ErrBudgetExceeded
	}
	if err := runContext.Err(); err != nil {
		return nil, invocationContextError(parent, runContext)
	}
	if isAfterPhase(invocation.Phase) {
		return nil, nil
	}
	return json.RawMessage(serialized), nil
}

func makeInvocationAPI(js *qjsengine.Context, helper *qjsengine.Value, invocation Invocation, ctx context.Context) (*qjsengine.Value, error) {
	if isBeforePhase(invocation.Phase) {
		api := js.NewObject()
		api.SetPropertyStr("apiVersion", js.NewString("modelry.extension/v1"))
		freeze := helper.GetPropertyStr("freeze")
		defer freeze.Free()
		if !freeze.IsFunction() {
			api.Free()
			return nil, ErrExecutionFailed
		}
		frozen, err := js.Invoke(freeze, js.NewUndefined(), api)
		if err != nil {
			api.Free()
			return nil, ErrExecutionFailed
		}
		if frozen != nil {
			frozen.Free()
		}
		return api, nil
	}

	secretBridge := js.Function(func(call *qjsengine.This) (*qjsengine.Value, error) {
		if call == nil || len(call.Args()) != 1 || !call.Args()[0].IsString() || invocation.SecretLookup == nil {
			return nil, ErrSecretUnavailable
		}
		if err := ctx.Err(); err != nil {
			return nil, ErrSecretUnavailable
		}
		value, err := invocation.SecretLookup(ctx, call.Args()[0].String())
		if err != nil || !utf8.ValidString(value) || len([]byte(value)) > maximumSecretBytes {
			return nil, ErrSecretUnavailable
		}
		if value == "" {
			return js.NewUndefined(), nil
		}
		return js.NewString(value), nil
	})
	defer secretBridge.Free()

	httpBridge := js.Function(func(call *qjsengine.This) (*qjsengine.Value, error) {
		if call == nil || len(call.Args()) != 1 || !call.Args()[0].IsString() || invocation.HTTPRequest == nil {
			return nil, ErrExternalRequestFailed
		}
		if err := ctx.Err(); err != nil {
			return nil, ErrExternalRequestFailed
		}
		requestBytes := []byte(call.Args()[0].String())
		if len(requestBytes) == 0 || len(requestBytes) > maximumHTTPInputBytes || !utf8.Valid(requestBytes) || !json.Valid(requestBytes) {
			return nil, ErrExternalRequestFailed
		}
		response, err := invocation.HTTPRequest(ctx, json.RawMessage(requestBytes))
		if err != nil || len(response) == 0 || len(response) > maximumHookOutputBytes || !utf8.Valid(response) || !json.Valid(response) {
			return nil, ErrExternalRequestFailed
		}
		result := js.ParseJSON(string(response))
		if js.HasException() {
			_ = js.Exception()
			result.Free()
			return nil, ErrExternalRequestFailed
		}
		return result, nil
	})
	defer httpBridge.Free()

	makeAfterAPI := helper.GetPropertyStr("makeAfterAPI")
	defer makeAfterAPI.Free()
	if !makeAfterAPI.IsFunction() {
		return nil, ErrExecutionFailed
	}
	api, err := js.Invoke(makeAfterAPI, js.NewUndefined(), secretBridge, httpBridge)
	if err != nil || api == nil || !api.IsObject() {
		if api != nil {
			api.Free()
		}
		return nil, ErrExecutionFailed
	}
	return api, nil
}

func validHookPhase(phase string) bool {
	switch phase {
	case phaseBeforeCreate, phaseBeforeUpdate, phaseBeforeDelete,
		phaseAfterCommitCreate, phaseAfterCommitUpdate, phaseAfterCommitDelete:
		return true
	default:
		return false
	}
}

func isBeforePhase(phase string) bool {
	return phase == phaseBeforeCreate || phase == phaseBeforeUpdate || phase == phaseBeforeDelete
}

func isAfterPhase(phase string) bool {
	return phase == phaseAfterCommitCreate || phase == phaseAfterCommitUpdate || phase == phaseAfterCommitDelete
}

func validCompiledCode(code string) bool {
	return len(code) > 0 && len([]byte(code)) <= maximumSourceBytes && utf8.ValidString(code)
}

func validHookContext(value json.RawMessage) bool {
	if len(value) == 0 || len(value) > maximumHookInputBytes || !utf8.Valid(value) || !json.Valid(value) {
		return false
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(value, &object); err != nil || object == nil {
		return false
	}
	return true
}

func invocationContextError(parent, run context.Context) error {
	if errors.Is(parent.Err(), context.Canceled) {
		return ErrInvocationCancelled
	}
	if errors.Is(run.Err(), context.DeadlineExceeded) || errors.Is(parent.Err(), context.DeadlineExceeded) {
		return ErrBudgetExceeded
	}
	return ErrExecutionFailed
}

func closeInvocationRuntime(runtime *qjsengine.Runtime) {
	defer func() { _ = recover() }()
	runtime.Close()
}

func lockdownSource(before bool) string {
	const alwaysLocked = `(() => {
	const define = Object.defineProperty;
	const names = ["eval", "Function", "Promise", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "fetch", "XMLHttpRequest", "WebSocket", "Worker", "SharedWorker", "performance", "crypto", "console", "process", "Deno", "Bun", "require", "module", "global", "Buffer", "std", "os"];
	for (const name of names) {
	  try { define(globalThis, name, { value: undefined, writable: false, configurable: false, enumerable: false }); } catch (_) {}
	}
	const functionPrototype = Object.getPrototypeOf(function () {});
	try { define(functionPrototype, "constructor", { value: undefined, writable: false, configurable: false }); } catch (_) {}
	const asyncPrototype = Object.getPrototypeOf(async function () {});
	try { define(asyncPrototype, "constructor", { value: undefined, writable: false, configurable: false }); } catch (_) {}
	const generatorPrototype = Object.getPrototypeOf(function* () {});
	try { define(generatorPrototype, "constructor", { value: undefined, writable: false, configurable: false }); } catch (_) {}
	const asyncGeneratorPrototype = Object.getPrototypeOf(async function* () {});
	try { define(asyncGeneratorPrototype, "constructor", { value: undefined, writable: false, configurable: false }); } catch (_) {}
})();`
	if !before {
		return alwaysLocked
	}
	return "(() => {\n" + alwaysLocked + `
	const define = Object.defineProperty;
	try { define(globalThis, "Date", { value: undefined, writable: false, configurable: false, enumerable: false }); } catch (_) {}
	try { define(Math, "random", { value: undefined, writable: false, configurable: false }); Object.freeze(Math); } catch (_) {}
})();`
}

const hostHelpersSource = `(() => {
	const define = Object.defineProperty;
	const freeze = Object.freeze;
	const keys = Object.keys;
const stringify = JSON.stringify;
	const ErrorConstructor = Error;
	const asyncFunctionPrototype = Object.getPrototypeOf(async function () {});
	const deepFreeze = value => {
		if (value && typeof value === "object" && !Object.isFrozen(value)) {
			for (const key of keys(value)) deepFreeze(value[key]);
			freeze(value);
		}
		return value;
	};
	const install = api => define(globalThis, "modelry", {
		value: api, writable: false, configurable: false, enumerable: true
	});
	const makeAfterAPI = (secretBridge, httpBridge) => {
		const secrets = freeze({
			get(alias) {
				if (typeof alias !== "string") throw new ErrorConstructor("secretNotAvailable");
				return secretBridge(alias);
			}
		});
		const http = freeze({
			request(request) {
				let input;
				try { input = stringify(request); } catch (_) { throw new ErrorConstructor("externalRequestFailed"); }
				if (typeof input !== "string") throw new ErrorConstructor("externalRequestFailed");
				return httpBridge(input);
			}
		});
		return freeze({ apiVersion: "modelry.extension/v1", secrets, http });
	};
	const isAsync = fn => Object.getPrototypeOf(fn) === asyncFunctionPrototype;
	return freeze({ install, deepFreeze, freeze, makeAfterAPI, isAsync, stringify(value) { return stringify(value); } });
})()`
