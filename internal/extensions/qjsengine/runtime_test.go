package qjs

import (
	"context"
	"io"
	"testing"
	"time"
)

func TestRuntimeEnforcesQuickJSHeapLimit(t *testing.T) {
	runtime, err := New(Option{Context: context.Background(), MemoryLimit: 32 << 20, MaxStackSize: 1 << 20, Stdout: io.Discard, Stderr: io.Discard})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer runtime.Close()
	value, err := runtime.Eval("heap-limit.js", Code(`try { new ArrayBuffer(64 * 1024 * 1024); globalThis.__probe = "allocated"; } catch { globalThis.__probe = "limited"; }`))
	if err != nil {
		t.Fatalf("Eval() error = %v", err)
	}
	value.Free()
	if got := globalString(runtime, "__probe"); got != "limited" {
		t.Fatalf("heap probe = %q, want limited", got)
	}
}

func TestRuntimeEnforcesWasmMemoryLimit(t *testing.T) {
	runtime, err := New(Option{Context: context.Background(), MemoryLimit: 0, MaxStackSize: 1 << 20, Stdout: io.Discard, Stderr: io.Discard})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer runtime.Close()
	if value, err := runtime.Eval("wasm-limit.js", Code(`globalThis.__probe = new ArrayBuffer(512 * 1024 * 1024);`)); err == nil {
		value.Free()
		t.Fatal("Eval() allocated beyond the Wazero memory limit")
	}
}

func TestRuntimeEmptyReadOnlyFilesystem(t *testing.T) {
	runtime, err := New(Option{Context: context.Background(), MemoryLimit: 32 << 20, MaxStackSize: 1 << 20, Stdout: io.Discard, Stderr: io.Discard})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer runtime.Close()
	source := `import * as std from "qjs:std";
let readBlocked = false;
let writeBlocked = false;
try { readBlocked = std.loadFile("/modelry-sentinel") !== "modelry-host-sentinel"; } catch { readBlocked = true; }
try { const file = std.open("/modelry-write-probe", "w"); file.puts("probe"); file.close(); } catch { writeBlocked = true; }
globalThis.__readBlocked = readBlocked;
globalThis.__writeBlocked = writeBlocked;`
	value, err := runtime.Eval("filesystem-probe.mjs", Code(source), TypeModule())
	if err != nil {
		t.Fatalf("Eval() error = %v", err)
	}
	value.Free()
	readBlocked := globalBool(runtime, "__readBlocked")
	writeBlocked := globalBool(runtime, "__writeBlocked")
	if !readBlocked || !writeBlocked {
		t.Fatalf("guest filesystem read-blocked=%t write-blocked=%t; both must be true", readBlocked, writeBlocked)
	}
}

func TestRuntimeCancellationClosesInstanceAndAllowsFreshRuntime(t *testing.T) {
	warm, err := New(Option{Context: context.Background(), MemoryLimit: 32 << 20, MaxStackSize: 1 << 20, Stdout: io.Discard, Stderr: io.Discard})
	if err != nil {
		t.Fatalf("warm New() error = %v", err)
	}
	if value, err := warm.Eval("warm.js", Code("1 + 1")); err != nil {
		t.Fatalf("warm Eval() error = %v", err)
	} else {
		value.Free()
	}
	warm.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	interrupted, err := New(Option{Context: ctx, MemoryLimit: 32 << 20, MaxStackSize: 1 << 20, Stdout: io.Discard, Stderr: io.Discard})
	if err != nil {
		t.Fatalf("interrupted New() error = %v", err)
	}
	if value, err := interrupted.Eval("loop.js", Code(`for (;;) {}`)); err == nil {
		value.Free()
		t.Fatal("Eval() did not stop after context cancellation")
	}
	interrupted.Close()

	fresh, err := New(Option{Context: context.Background(), MemoryLimit: 32 << 20, MaxStackSize: 1 << 20, Stdout: io.Discard, Stderr: io.Discard})
	if err != nil {
		t.Fatalf("fresh New() error = %v", err)
	}
	defer fresh.Close()
	value, err := fresh.Eval("fresh.js", Code("6 * 7"))
	if err != nil {
		t.Fatalf("fresh Eval() error = %v", err)
	}
	defer value.Free()
	if got := value.Int64(); got != 42 {
		t.Fatalf("fresh runtime result = %d, want 42", got)
	}
}

func globalString(runtime *Runtime, name string) string {
	value := runtime.Context().Global().GetPropertyStr(name)
	defer value.Free()
	return value.String()
}

func globalBool(runtime *Runtime, name string) bool {
	value := runtime.Context().Global().GetPropertyStr(name)
	defer value.Free()
	return value.Bool()
}
