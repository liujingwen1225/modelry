package project

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	managedDirectory = ".modelry"
	databaseFile     = "project.sqlite"
	lockFile         = "runtime.lock"
)

type RootSource string

const (
	SourceFlag        RootSource = "flag"
	SourceEnvironment RootSource = "environment"
	SourceWorkingDir  RootSource = "working-directory"
)

type RootConfig struct {
	FlagPath       *string
	Environment    string
	EnvironmentSet bool
	WorkingDir     string
}

type Root struct {
	Path       string
	Source     RootSource
	ManagedDir string
	Database   string
	Lock       string
	Files      string
	TempFiles  string
	Objects    string
}

func ResolveRoot(config RootConfig) (Root, error) {
	var selected string
	var source RootSource
	switch {
	case config.FlagPath != nil:
		selected = *config.FlagPath
		source = SourceFlag
	case config.EnvironmentSet:
		selected = config.Environment
		source = SourceEnvironment
	default:
		selected = config.WorkingDir
		source = SourceWorkingDir
	}
	if selected == "" {
		return Root{}, fmt.Errorf("project root selected from %s is empty; provide --project-root, set MODELRY_PROJECT_ROOT, or run Modelry from an existing project directory", source)
	}
	if config.WorkingDir == "" {
		return Root{}, errors.New("cannot resolve project root without the process working directory")
	}

	resolved := selected
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(config.WorkingDir, resolved)
	}
	resolved, err := filepath.Abs(filepath.Clean(resolved))
	if err != nil {
		return Root{}, fmt.Errorf("cannot resolve project root selected from %s: %w", source, err)
	}
	resolved, err = filepath.EvalSymlinks(resolved)
	if err != nil {
		return Root{}, fmt.Errorf("project root %q selected from %s cannot be resolved: %w; create or select an existing accessible directory", resolved, source, err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return Root{}, fmt.Errorf("project root %q selected from %s cannot be accessed: %w", resolved, source, err)
	}
	if !info.IsDir() {
		return Root{}, fmt.Errorf("project root %q selected from %s is not a directory; choose an existing directory", resolved, source)
	}
	directory, err := os.Open(resolved)
	if err != nil {
		return Root{}, fmt.Errorf("project root %q selected from %s is not accessible: %w", resolved, source, err)
	}
	if err := directory.Close(); err != nil {
		return Root{}, fmt.Errorf("project root %q selected from %s could not be checked: %w", resolved, source, err)
	}

	managed := filepath.Join(resolved, managedDirectory)
	files := filepath.Join(managed, "files")
	return Root{
		Path:       resolved,
		Source:     source,
		ManagedDir: managed,
		Database:   filepath.Join(managed, databaseFile),
		Lock:       filepath.Join(managed, lockFile),
		Files:      files,
		TempFiles:  filepath.Join(files, "tmp"),
		Objects:    filepath.Join(files, "objects"),
	}, nil
}
