//go:build !unix && !windows

package portability

import "errors"

var errDirectorySyncUnsupported = errors.New("directory sync is unsupported on this platform")

func syncDirectory(string) error { return errDirectorySyncUnsupported }

func directorySyncSupported() bool { return false }
