//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package secretstore

import (
	"os"
)

func syncKeyDirectory(store *Store) error {
	if store == nil {
		return ErrInvalidArgument
	}
	directory, err := os.Open(store.managedDir)
	if err != nil {
		return ErrKeyInvalid
	}
	defer directory.Close()
	info, err := directory.Stat()
	if err != nil || !os.SameFile(store.managedInfo, info) {
		return ErrKeyInvalid
	}
	if err := directory.Sync(); err != nil {
		return ErrKeyInvalid
	}
	return store.verifyManagedDirectory()
}
