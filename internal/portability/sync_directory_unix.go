//go:build unix

package portability

import (
	"errors"
	"os"
)

// syncDirectory persists directory-entry changes on POSIX filesystems. Unlike
// file Sync, syncing the containing directory is what makes rename/create/remove
// ordering durable across a crash. Errors are intentionally returned to callers.
func syncDirectory(directory string) error {
	if directory == "" {
		directory = "."
	}
	handle, err := os.Open(directory)
	if err != nil {
		return err
	}
	syncErr := handle.Sync()
	closeErr := handle.Close()
	return errors.Join(syncErr, closeErr)
}

func directorySyncSupported() bool { return true }
