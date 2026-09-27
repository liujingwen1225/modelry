//go:build !aix && !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd && !solaris && !windows

package secretstore

import "errors"

var errKeyDirectorySyncUnsupported = errors.New("project key directory sync is unsupported on this platform")

func syncKeyDirectory(*Store) error { return errKeyDirectorySyncUnsupported }
