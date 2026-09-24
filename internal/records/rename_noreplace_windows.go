//go:build windows

package records

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func renameNoReplace(source, destination string) error {
	sourcePath, err := windows.UTF16PtrFromString(windowsExtendedPath(source))
	if err != nil {
		return err
	}
	destinationPath, err := windows.UTF16PtrFromString(windowsExtendedPath(destination))
	if err != nil {
		return err
	}
	// MoveFileW 在目标已存在时失败；同卷移动使用文件系统 rename。
	return windows.MoveFile(sourcePath, destinationPath)
}

func windowsExtendedPath(path string) string {
	path = filepath.Clean(path)
	if strings.HasPrefix(path, `\\?\`) || strings.HasPrefix(path, `\\.\`) {
		return path
	}
	if strings.HasPrefix(path, `\\`) {
		return `\\?\UNC\` + strings.TrimPrefix(path, `\\`)
	}
	if len(path) >= 3 && path[1] == ':' && path[2] == '\\' {
		return `\\?\` + path
	}
	return path
}
