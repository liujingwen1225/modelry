package filestore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newLocalFixture(t *testing.T) (*Local, string, string) {
	t.Helper()
	root := t.TempDir()
	stagingDir := filepath.Join(root, "tmp")
	objectsDir := filepath.Join(root, "objects")
	for _, directory := range []string{stagingDir, objectsDir} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	provider, err := NewLocal(objectsDir)
	if err != nil {
		t.Fatal(err)
	}
	return provider, stagingDir, objectsDir
}

func writeStaged(t *testing.T, directory, name, contents string) string {
	t.Helper()
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLocalPromoteKeepsExistingImmutableObject(t *testing.T) {
	provider, stagingDir, objectsDir := newLocalFixture(t)
	existingKey := "obj_" + strings.Repeat("a", 32)
	if err := os.WriteFile(filepath.Join(objectsDir, existingKey), []byte("durable object"), 0o600); err != nil {
		t.Fatal(err)
	}
	stagedPath := writeStaged(t, stagingDir, "tmp_"+strings.Repeat("b", 32), "new upload")
	err := provider.Promote(context.Background(), existingKey, Staged{Path: stagedPath, Size: int64(len("new upload")), ContentType: "text/plain"})
	if !errors.Is(err, ErrObjectExists) {
		t.Fatalf("promote over existing object error = %v, want ErrObjectExists", err)
	}
	contents, err := os.ReadFile(filepath.Join(objectsDir, existingKey))
	if err != nil || string(contents) != "durable object" {
		t.Fatalf("existing immutable object changed: %q err=%v", contents, err)
	}
	if _, err := os.Stat(stagedPath); err != nil {
		t.Fatalf("staged upload must survive a rejected promote: %v", err)
	}
}

func TestLocalPromoteOpenStatDeleteRoundTrip(t *testing.T) {
	provider, stagingDir, objectsDir := newLocalFixture(t)
	key := "obj_" + strings.Repeat("c", 32)
	contents := "attachment bytes"
	stagedPath := writeStaged(t, stagingDir, "tmp_"+strings.Repeat("d", 32), contents)
	if err := provider.Promote(context.Background(), key, Staged{Path: stagedPath, Size: int64(len(contents)), ContentType: "text/plain"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stagedPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("promoted staged upload should be moved, stat error = %v", err)
	}
	file, info, err := provider.Open(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil || string(body) != contents || info.Size != int64(len(contents)) || info.ContentType != "text/plain" {
		t.Fatalf("opened object body=%q info=%+v err=%v", body, info, err)
	}
	stat, err := provider.Stat(context.Background(), key)
	if err != nil || stat.Size != info.Size {
		t.Fatalf("stat object = %+v err=%v", stat, err)
	}
	if err := provider.Delete(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	if err := provider.Delete(context.Background(), key); err != nil {
		t.Fatalf("delete must be idempotent: %v", err)
	}
	if _, err := provider.Stat(context.Background(), key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stat deleted object error = %v, want ErrNotFound", err)
	}
	if _, err := os.Stat(filepath.Join(objectsDir, key)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted object still present: %v", err)
	}
}

func TestLocalListPaginatesWithCursor(t *testing.T) {
	provider, stagingDir, _ := newLocalFixture(t)
	keys := []string{"obj_" + strings.Repeat("1", 32), "obj_" + strings.Repeat("2", 32), "obj_" + strings.Repeat("3", 32)}
	for index, key := range keys {
		stagedPath := writeStaged(t, stagingDir, "tmp_"+strings.Repeat(string(rune('a'+index)), 32), "payload")
		if err := provider.Promote(context.Background(), key, Staged{Path: stagedPath, Size: int64(len("payload")), ContentType: "text/plain"}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := provider.List(context.Background(), "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Objects) != 2 || first.NextCursor == "" {
		t.Fatalf("first page = %+v", first)
	}
	second, err := provider.List(context.Background(), first.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Objects) != 1 || second.Objects[0].Key != keys[2] {
		t.Fatalf("second page = %+v", second)
	}
}

func TestLocalHealthAndStagedValidation(t *testing.T) {
	provider, stagingDir, objectsDir := newLocalFixture(t)
	if health := provider.Health(context.Background()); health.State != StateReady {
		t.Fatalf("health = %+v", health)
	}
	if err := os.RemoveAll(objectsDir); err != nil {
		t.Fatal(err)
	}
	if health := provider.Health(context.Background()); health.State != StateUnavailable {
		t.Fatalf("health after directory removal = %+v", health)
	}
	stagedPath := writeStaged(t, stagingDir, "tmp_"+strings.Repeat("e", 32), "payload")
	if err := provider.Promote(context.Background(), "not-an-object-key", Staged{Path: stagedPath, Size: 7}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("invalid key error = %v", err)
	}
	if err := provider.Promote(context.Background(), "obj_"+strings.Repeat("f", 32), Staged{Path: stagedPath, Size: 4}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("size mismatch error = %v", err)
	}
}

func TestLocalOpenRejectsSymlinkedObject(t *testing.T) {
	provider, stagingDir, objectsDir := newLocalFixture(t)
	realPath := writeStaged(t, stagingDir, "real", "payload")
	key := "obj_" + strings.Repeat("9", 32)
	linkPath := filepath.Join(objectsDir, key)
	if err := os.Symlink(realPath, linkPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := provider.Stat(context.Background(), key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("symlinked object stat error = %v, want ErrNotFound", err)
	}
	if err := provider.Delete(context.Background(), key); err == nil {
		t.Fatalf("symlinked object must not be deleted silently")
	}
}

func TestLocalPromoteMovesBytesWithoutExtraCopy(t *testing.T) {
	provider, stagingDir, objectsDir := newLocalFixture(t)
	key := "obj_" + strings.Repeat("7", 32)
	contents := bytes.Repeat([]byte("x"), 4096)
	stagedPath := writeStaged(t, stagingDir, "tmp_"+strings.Repeat("8", 32), string(contents))
	if err := provider.Promote(context.Background(), key, Staged{Path: stagedPath, Size: int64(len(contents)), ContentType: "application/octet-stream"}); err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(filepath.Join(objectsDir, key))
	if err != nil || !bytes.Equal(stored, contents) {
		t.Fatalf("stored bytes mismatch: %v", err)
	}
}
