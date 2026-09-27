//go:build windows

package secretstore

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestRejectChangedWindowsDACL(t *testing.T) {
	managed := filepath.Join(t.TempDir(), ".modelry")
	if err := os.Mkdir(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := New(managed, "project-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureKey(false); err != nil {
		t.Fatal(err)
	}
	broad, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := broad.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(
		filepath.Join(managed, keyFileName),
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Encrypt("secret-a", 1, []byte("value")); err != ErrKeyInvalid {
		t.Fatalf("Encrypt with changed DACL = %v, want ErrKeyInvalid", err)
	}
}
