//go:build windows

package portability

import (
	"path/filepath"
	"testing"
)

func TestDirectorySyncWindowsCompatibilityContract(t *testing.T) {
	if directorySyncSupported() {
		t.Fatal("Windows compatibility path must report that directory fsync is unavailable")
	}
	// Windows explicitly relies on its same-volume rename and file-flush behavior;
	// this is not the POSIX durability guarantee.
	if err := syncDirectory(filepath.Join(t.TempDir(), "missing")); err != nil {
		t.Fatalf("Windows compatibility sync = %v", err)
	}
}
