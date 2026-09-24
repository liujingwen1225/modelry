package project

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveRootUsesFlagThenEnvironmentThenWorkingDirectory(t *testing.T) {
	working := t.TempDir()
	environment := t.TempDir()
	flag := t.TempDir()

	root, err := ResolveRoot(RootConfig{
		FlagPath:       &flag,
		Environment:    environment,
		EnvironmentSet: true,
		WorkingDir:     working,
	})
	if err != nil {
		t.Fatal(err)
	}
	if root.Path != canonicalPath(t, flag) || root.Source != SourceFlag {
		t.Fatalf("flag did not take precedence: %#v", root)
	}

	root, err = ResolveRoot(RootConfig{Environment: environment, EnvironmentSet: true, WorkingDir: working})
	if err != nil {
		t.Fatal(err)
	}
	if root.Path != canonicalPath(t, environment) || root.Source != SourceEnvironment {
		t.Fatalf("environment did not take precedence over working directory: %#v", root)
	}

	root, err = ResolveRoot(RootConfig{WorkingDir: working})
	if err != nil {
		t.Fatal(err)
	}
	if root.Path != canonicalPath(t, working) || root.Source != SourceWorkingDir {
		t.Fatalf("working directory was not selected by default: %#v", root)
	}
}

func TestResolveRootResolvesRelativePathFromWorkingDirectory(t *testing.T) {
	working := t.TempDir()
	child := filepath.Join(working, "project")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	selected := "project"
	root, err := ResolveRoot(RootConfig{FlagPath: &selected, WorkingDir: working})
	if err != nil {
		t.Fatal(err)
	}
	if root.Path != canonicalPath(t, child) {
		t.Fatalf("relative root = %q, want %q", root.Path, canonicalPath(t, child))
	}
	if root.Database != filepath.Join(root.Path, ".modelry", "project.sqlite") {
		t.Fatalf("database path was not built with filepath semantics: %q", root.Database)
	}
}

func canonicalPath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func TestResolveRootDoesNotCreateMissingDirectory(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	root, err := ResolveRoot(RootConfig{FlagPath: &missing, WorkingDir: t.TempDir()})
	if err == nil {
		t.Fatalf("expected missing root to fail, got %#v", root)
	}
	if _, statErr := os.Stat(missing); !os.IsNotExist(statErr) {
		t.Fatalf("missing project root was created: %v", statErr)
	}
}

func TestResolveRootRejectsFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := ResolveRoot(RootConfig{FlagPath: &file, WorkingDir: t.TempDir()})
	if err == nil {
		t.Fatalf("expected file root to fail, got %#v", root)
	}
	if !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("unexpected error: %v", err)
	}
}
