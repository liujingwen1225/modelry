//go:build !linux && !darwin && !windows

package filestore

import (
	"fmt"
	"runtime"
)

func renameNoReplace(string, string) error {
	return fmt.Errorf("atomic no-replace file rename is unsupported on %s", runtime.GOOS)
}
