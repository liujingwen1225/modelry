package filestore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Local 把对象引用映射为 Project 文件系统中的不可变文件。
// 它只使用 Runtime 已创建并验证过的对象目录，绝不拼接调用方提供的名字。
type Local struct {
	objectsDir string
	mu         sync.Mutex
}

// NewLocal 打开一个已验证的本地对象目录。
func NewLocal(objectsDir string) (*Local, error) {
	if objectsDir == "" {
		return nil, fmt.Errorf("%w: object directory is required", ErrInvalidArgument)
	}
	absolute, err := filepath.Abs(filepath.Clean(objectsDir))
	if err != nil {
		return nil, fmt.Errorf("%w: object directory cannot be resolved", ErrInvalidArgument)
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: object directory is missing or unsafe", ErrUnavailable)
	}
	return &Local{objectsDir: absolute}, nil
}

func (provider *Local) Name() string { return "local" }

func (provider *Local) Label() string { return "Local" }

// Promote 使用原子 no-replace rename 把暂存文件移动为不可变对象。
// 它不会删除暂存文件以掩盖失败：失败时调用方仍然持有可回收的暂存文件。
func (provider *Local) Promote(ctx context.Context, objectKey string, staged Staged) error {
	if provider == nil {
		return ErrUnavailable
	}
	if !ValidObjectKey(objectKey) {
		return ErrInvalidArgument
	}
	if err := ValidateStaged(staged); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	provider.mu.Lock()
	defer provider.mu.Unlock()
	source := filepath.Join(filepath.Dir(staged.Path), filepath.Base(staged.Path))
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: staged upload is no longer available", ErrInvalidArgument)
	}
	if info.Size() != staged.Size {
		return fmt.Errorf("%w: staged upload size changed before binding", ErrInvalidArgument)
	}
	destination := filepath.Join(provider.objectsDir, objectKey)
	if _, err := os.Lstat(destination); err == nil {
		return ErrObjectExists
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("%w: object destination cannot be inspected", ErrUnavailable)
	}
	if err := renameNoReplace(source, destination); err != nil {
		if os.IsExist(err) {
			return ErrObjectExists
		}
		return fmt.Errorf("bind staged upload to an immutable object: %w", err)
	}
	return nil
}

func (provider *Local) Open(_ context.Context, objectKey string) (io.ReadCloser, Info, error) {
	file, err := provider.openObject(objectKey)
	if err != nil {
		return nil, Info{}, err
	}
	info, err := readObjectInfo(file)
	if err != nil {
		_ = file.Close()
		return nil, Info{}, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, Info{}, fmt.Errorf("rewind stored file object: %w", err)
	}
	return file, info, nil
}

func (provider *Local) Stat(_ context.Context, objectKey string) (Info, error) {
	file, err := provider.openObject(objectKey)
	if err != nil {
		return Info{}, err
	}
	defer file.Close()
	return readObjectInfo(file)
}

// Delete 是幂等的：对象已不存在时返回成功，便于 reconcile 重试。
func (provider *Local) Delete(_ context.Context, objectKey string) error {
	if provider == nil {
		return ErrUnavailable
	}
	if !ValidObjectKey(objectKey) {
		return ErrInvalidArgument
	}
	path := filepath.Join(provider.objectsDir, objectKey)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%w: object cannot be inspected", ErrUnavailable)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: object is not a regular file", ErrInvalidArgument)
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("delete unreferenced file object: %w", err)
	}
	return nil
}

func (provider *Local) List(_ context.Context, cursor string, limit int) (Page, error) {
	if provider == nil {
		return Page{}, ErrUnavailable
	}
	size, err := validListLimit(limit)
	if err != nil {
		return Page{}, err
	}
	if cursor != "" && !ValidObjectKey(cursor) {
		return Page{}, ErrInvalidArgument
	}
	entries, err := os.ReadDir(provider.objectsDir)
	if err != nil {
		return Page{}, fmt.Errorf("%w: object directory cannot be read", ErrUnavailable)
	}
	keys := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() || !ValidObjectKey(name) {
			continue
		}
		if cursor != "" && name <= cursor {
			continue
		}
		keys = append(keys, name)
	}
	sort.Strings(keys)
	page := Page{Objects: make([]Object, 0, min(len(keys), size))}
	for _, key := range keys {
		if len(page.Objects) == size {
			page.NextCursor = page.Objects[len(page.Objects)-1].Key
			break
		}
		entry, err := os.Lstat(filepath.Join(provider.objectsDir, key))
		if err != nil {
			continue
		}
		page.Objects = append(page.Objects, Object{Key: key, Size: entry.Size(), ModifiedAt: entry.ModTime().UTC()})
	}
	return page, nil
}

func (provider *Local) Health(ctx context.Context) Health {
	if provider == nil {
		return Health{State: StateUnavailable, Message: "Local Storage is not initialized.", Hint: "Restart the Runtime so Modelry can prepare the project file directories."}
	}
	if err := ctx.Err(); err != nil {
		return Health{State: StateUnknown, Message: "Local Storage health was not probed in time.", Hint: "Retry the status request."}
	}
	info, err := os.Lstat(provider.objectsDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Health{State: StateUnavailable, Message: "The Local object directory is missing or unsafe.", Hint: "Restore the .modelry/files/objects directory and restart the Runtime."}
	}
	if err := probeWritable(provider.objectsDir); err != nil {
		return Health{State: StateUnavailable, Message: "The Local object directory is not writable.", Hint: "Fix filesystem permissions for .modelry/files/objects, then retry."}
	}
	return Health{State: StateReady, Message: "Local Storage is responding.", Hint: ""}
}

func (provider *Local) openObject(objectKey string) (*os.File, error) {
	if provider == nil {
		return nil, ErrUnavailable
	}
	if !ValidObjectKey(objectKey) {
		return nil, ErrInvalidArgument
	}
	path := filepath.Join(provider.objectsDir, objectKey)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: object cannot be inspected", ErrUnavailable)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrNotFound
	}
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("%w: object cannot be opened", ErrUnavailable)
	}
	return file, nil
}

// readObjectInfo 从字节内容嗅探 MIME 类型；调用方提供的文件名或请求头永不参与判断。
func readObjectInfo(file *os.File) (Info, error) {
	buffer := make([]byte, 512)
	count, err := file.Read(buffer)
	if err != nil && err != io.EOF {
		return Info{}, fmt.Errorf("read stored object metadata: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		return Info{}, fmt.Errorf("stat stored object: %w", err)
	}
	contentType, _, _ := mime.ParseMediaType(http.DetectContentType(buffer[:count]))
	return Info{Size: info.Size(), ContentType: contentType}, nil
}

func probeWritable(directory string) error {
	var value [8]byte
	if _, err := rand.Read(value[:]); err != nil {
		return err
	}
	path := filepath.Join(directory, ".probe_"+hex.EncodeToString(value[:]))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	closeErr := file.Close()
	removeErr := os.Remove(path)
	if closeErr != nil {
		return closeErr
	}
	return removeErr
}

// maxUploadAge 让 reconcile 与 Provider 使用同一宽限期语义。
func maxUploadAge(cutoff time.Time, modified time.Time) bool {
	return modified.After(cutoff) || modified.Equal(cutoff)
}
