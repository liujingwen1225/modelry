package project

import (
	"fmt"
	"os"

	"github.com/gofrs/flock"
)

type RuntimeLock struct {
	file *flock.Flock
}

func AcquireRuntimeLock(root Root) (*RuntimeLock, error) {
	if err := os.MkdirAll(root.ManagedDir, 0o700); err != nil {
		return nil, fmt.Errorf("cannot prepare Modelry state for project root %q selected from %s: %w", root.Path, root.Source, err)
	}
	file := flock.New(root.Lock)
	locked, err := file.TryLock()
	if err != nil {
		return nil, fmt.Errorf("cannot acquire the Modelry runtime lock for project root %q: %w", root.Path, err)
	}
	if !locked {
		return nil, fmt.Errorf("another Modelry Runtime already holds project root %q (selected from %s); stop the existing process before retrying", root.Path, root.Source)
	}
	return &RuntimeLock{file: file}, nil
}

func (lock *RuntimeLock) Release() error {
	if lock == nil || lock.file == nil {
		return nil
	}
	if err := lock.file.Unlock(); err != nil {
		return fmt.Errorf("cannot release the Modelry runtime lock: %w", err)
	}
	lock.file = nil
	return nil
}
