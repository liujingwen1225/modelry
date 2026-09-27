//go:build !windows

package secretstore

import (
	"os"
)

func secureNewKeyFile(_ string, file *os.File) error {
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil || info.Mode().Perm() != 0o600 {
		return ErrKeyInvalid
	}
	return nil
}

func verifyKeyAccess(path string, file *os.File) error {
	var info os.FileInfo
	var err error
	if file == nil {
		info, err = os.Lstat(path)
	} else {
		info, err = file.Stat()
	}
	if err != nil || info.Mode().Perm() != 0o600 {
		return ErrKeyInvalid
	}
	return nil
}
