package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"

	"github.com/liujingwen1225/modelry/internal/project"
	runtimeapp "github.com/liujingwen1225/modelry/internal/runtime"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var version = "dev"

type rootFlags struct {
	path     string
	provided bool
}

type readyRecord struct {
	State         string `json:"state"`
	URL           string `json:"url"`
	Address       string `json:"address"`
	ProjectID     string `json:"projectId"`
	ProjectSource string `json:"projectSource"`
	Version       string `json:"version"`
}

type statusRecord struct {
	State             string `json:"state"`
	ProjectID         string `json:"projectId"`
	ProjectRoot       string `json:"projectRoot"`
	ProjectSource     string `json:"projectSource"`
	DatabaseState     string `json:"databaseState"`
	DatabasePath      string `json:"databasePath"`
	LocalStorageState string `json:"localStorageState"`
	LocalStoragePath  string `json:"localStoragePath"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printUsage(stderr)
		return 2
	}
	if args[0] == "--version" || args[0] == "version" {
		_, _ = fmt.Fprintf(stdout, "modelry %s\n", version)
		return 0
	}
	switch args[0] {
	case "admin":
		return runAdmin(args[1:], stdout, stderr)
	case "mcp":
		return runMCP(args[1:], os.Stdin, stdout, stderr)
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot read process working directory: %v\n", err)
		return 1
	}
	switch args[0] {
	case "start":
		return runStart(args[1:], stdout, stderr, workingDirectory)
	case "status":
		return runStatus(args[1:], stdout, stderr, workingDirectory)
	default:
		_, _ = fmt.Fprintf(stderr, "unknown command %q\n", args[0])
		printUsage(stderr)
		return 2
	}
}

func runStart(args []string, stdout, stderr io.Writer, workingDirectory string) int {
	ctx, cancel := systemContext()
	defer cancel()
	return runStartContext(ctx, args, stdout, stderr, workingDirectory)
}

func runStartContext(ctx context.Context, args []string, stdout, stderr io.Writer, workingDirectory string) int {
	flags := flag.NewFlagSet("start", flag.ContinueOnError)
	flags.SetOutput(stderr)
	rootPath := flags.String("project-root", "", "Project Root directory")
	listenAddress := flags.String("listen", "127.0.0.1:8080", "HTTP listen address")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		_, _ = fmt.Fprintf(stderr, "unexpected start arguments: %v\n", flags.Args())
		return 2
	}
	rootConfig := makeRootConfig(flags, rootPath, workingDirectory)
	instance, err := runtimeapp.New(runtimeapp.Options{ProjectRoot: rootConfig, Version: version})
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot start Modelry: %v\n", err)
		return 1
	}
	defer instance.Close()
	err = instance.Run(ctx, *listenAddress, func(address net.Addr) {
		record := readyRecord{
			State:         "ready",
			URL:           "http://" + address.String(),
			Address:       address.String(),
			ProjectID:     instance.ProjectID(),
			ProjectSource: string(instance.Root().Source),
			Version:       version,
		}
		encoded, encodeErr := json.Marshal(record)
		if encodeErr != nil {
			_, _ = fmt.Fprintf(stderr, "cannot encode READY event: %v\n", encodeErr)
			return
		}
		_, _ = fmt.Fprintf(stdout, "READY %s\n", encoded)
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		_, _ = fmt.Fprintf(stderr, "Modelry stopped with an error: %v\n", err)
		return 1
	}
	return 0
}

func runStatus(args []string, stdout, stderr io.Writer, workingDirectory string) int {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	flags.SetOutput(stderr)
	rootPath := flags.String("project-root", "", "Project Root directory")
	jsonOutput := flags.Bool("json", false, "Print status as JSON")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		_, _ = fmt.Fprintf(stderr, "unexpected status arguments: %v\n", flags.Args())
		return 2
	}
	root, err := project.ResolveRoot(makeRootConfig(flags, rootPath, workingDirectory))
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot read Modelry status: %v\n", err)
		return 1
	}
	projectID, err := storage.ReadProjectID(root.Database)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot read Modelry status: %v\n", err)
		return 1
	}
	record := statusRecord{
		State:             "initialized",
		ProjectID:         projectID,
		ProjectRoot:       root.Path,
		ProjectSource:     string(root.Source),
		DatabaseState:     "ready",
		DatabasePath:      root.Database,
		LocalStorageState: "unknown",
		LocalStoragePath:  root.Files,
	}
	if directoryExists(root.TempFiles) && directoryExists(root.Objects) {
		record.LocalStorageState = "ready"
	}
	if *jsonOutput {
		if err := json.NewEncoder(stdout).Encode(record); err != nil {
			_, _ = fmt.Fprintf(stderr, "cannot print Modelry status: %v\n", err)
			return 1
		}
		return 0
	}
	_, _ = fmt.Fprintf(stdout, "Project ID: %s\nProject Root: %s\nDatabase: %s (%s)\nLocal Storage: %s (%s)\n", record.ProjectID, record.ProjectRoot, record.DatabasePath, record.DatabaseState, record.LocalStoragePath, record.LocalStorageState)
	return 0
}

func makeRootConfig(flags *flag.FlagSet, rootPath *string, workingDirectory string) project.RootConfig {
	var flagPath *string
	flags.Visit(func(visited *flag.Flag) {
		if visited.Name == "project-root" {
			flagPath = rootPath
		}
	})
	environment, environmentSet := os.LookupEnv("MODELRY_PROJECT_ROOT")
	return project.RootConfig{
		FlagPath:       flagPath,
		Environment:    environment,
		EnvironmentSet: environmentSet,
		WorkingDir:     workingDirectory,
	}
}

func directoryExists(name string) bool {
	info, err := os.Stat(filepath.Clean(name))
	return err == nil && info.IsDir()
}

func printUsage(writer io.Writer) {
	_, _ = fmt.Fprintln(writer, "Usage: modelry <start|status|admin|mcp|version>")
	_, _ = fmt.Fprintln(writer, "  start [--project-root PATH] [--listen ADDRESS]")
	_, _ = fmt.Fprintln(writer, "  status [--project-root PATH] [--json]")
	_, _ = fmt.Fprintln(writer, "  admin [--api-url URL] [--api-key KEY] <collections|records|schema|access|requests|audit> <operation>")
	_, _ = fmt.Fprintln(writer, "  mcp [--api-url URL] [--api-key KEY]")
}
