//go:build unix

package portability

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDirectorySyncPOSIXContract(t *testing.T) {
	if !directorySyncSupported() {
		t.Fatal("POSIX builds must enable directory fsync")
	}
	directory := t.TempDir()
	if err := syncDirectory(directory); err != nil {
		t.Fatalf("sync existing directory: %v", err)
	}
	missing := filepath.Join(directory, "missing")
	if err := syncDirectory(missing); err == nil {
		t.Fatal("sync of a missing directory was silently ignored")
	} else if !os.IsNotExist(err) {
		t.Fatalf("sync missing directory error = %v, want an OS error", err)
	}
}
