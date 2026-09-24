package project

import (
	"testing"
)

func TestRuntimeLockAllowsOnlyOneProcessAndCanBeReacquired(t *testing.T) {
	rootPath := t.TempDir()
	root, err := ResolveRoot(RootConfig{FlagPath: &rootPath, WorkingDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	first, err := AcquireRuntimeLock(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireRuntimeLock(root); err == nil {
		t.Fatal("second runtime acquired a held project lock")
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := AcquireRuntimeLock(root)
	if err != nil {
		t.Fatalf("lock could not be acquired after release: %v", err)
	}
	if err := second.Release(); err != nil {
		t.Fatal(err)
	}
}
