//go:build windows

package secretstore

// Windows does not expose POSIX directory fsync through Go's os.File.Sync.
// The caller has already synced the key file and retains the existing same-volume
// atomic-file and ACL checks; directory-entry durability follows filesystem guarantees.
func syncKeyDirectory(store *Store) error {
	if store == nil {
		return ErrInvalidArgument
	}
	return store.verifyManagedDirectory()
}
