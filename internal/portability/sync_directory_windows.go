//go:build windows

package portability

// Windows does not expose POSIX directory fsync through Go's os.File.Sync.
// Restore still flushes every staged file and uses same-volume atomic renames;
// directory-entry durability follows the guarantees of the Windows filesystem.
// Keep this compatibility policy explicit and separate from the POSIX path.
func syncDirectory(string) error { return nil }

func directorySyncSupported() bool { return false }
