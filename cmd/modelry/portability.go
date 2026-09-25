package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/portability"
	"github.com/liujingwen1225/modelry/internal/project"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// cliObjects 让 CLI 直接从本地对象目录读取被引用的文件对象。
// CLI 只在项目已停止时运行，因此不需要运行中的 Provider。
type cliObjects struct {
	keys   []string
	root   string
	locked bool
}

func (source cliObjects) ReferencedFileKeys(context.Context) ([]string, error) {
	return source.keys, nil
}

func (source cliObjects) OpenObject(_ context.Context, key string) (io.ReadCloser, error) {
	return os.Open(filepath.Join(source.root, key))
}

type cliManifestSummary struct {
	Bundle        string `json:"bundle"`
	Bytes         int64  `json:"bytes"`
	Digest        string `json:"digest"`
	ProjectID     string `json:"projectId"`
	Collections   int64  `json:"collections"`
	Records       int64  `json:"records"`
	Objects       int64  `json:"objects"`
	RuntimeVersion string `json:"runtimeVersion"`
}

func runBackup(args []string, stdout, stderr io.Writer, workingDirectory string) int {
	flags := flag.NewFlagSet("backup", flag.ContinueOnError)
	flags.SetOutput(stderr)
	rootPath := flags.String("project-root", "", "Project Root directory")
	output := flags.String("out", "", "Backup bundle path")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	rootConfig := makeRootConfig(flags, rootPath, workingDirectory)
	root, err := project.ResolveRoot(rootConfig)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot resolve project root: %v\n", err)
		return 1
	}
	lock, err := project.AcquireRuntimeLock(root)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot take a consistent backup while the project is in use: %v\n", err)
		return 1
	}
	defer lock.Release()

	store, err := storage.Open(root.Database)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot open project storage: %v\n", err)
		return 1
	}
	defer store.Close()
	models, err := backendmodel.NewService(context.Background(), store)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot open the Backend Model: %v\n", err)
		return 1
	}
	recordService, err := records.New(store, models)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot prepare Record access: %v\n", err)
		return 1
	}
	objects, err := recordService.ReferencedFileKeys(context.Background())
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot read referenced file objects: %v\n", err)
		return 1
	}
	service, err := portability.NewService(portability.Options{
		Store: store, Objects: cliObjects{keys: objects, root: root.Objects}, Models: models,
		ManagedDir: root.ManagedDir, Version: version,
	})
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot prepare backup: %v\n", err)
		return 1
	}
	destination := *output
	if destination == "" {
		destination = filepath.Join(root.Path, "modelry-backup-"+store.ProjectID()+".tar")
	}
	result, err := service.CreateBackup(context.Background(), portability.BackupOptions{Destination: destination})
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "backup failed: %v\n", err)
		return 1
	}
	summary := cliManifestSummary{
		Bundle: result.Path, Bytes: result.Bytes, Digest: result.Digest, ProjectID: store.ProjectID(),
		Collections: result.Counts.Collections, Records: result.Counts.Records, Objects: result.Counts.Objects,
		RuntimeVersion: version,
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot encode backup summary: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintln(stdout, string(encoded))
	return 0
}

func runRestore(args []string, stdout, stderr io.Writer, workingDirectory string) int {
	flags := flag.NewFlagSet("restore", flag.ContinueOnError)
	flags.SetOutput(stderr)
	rootPath := flags.String("project-root", "", "Project Root directory")
	from := flags.String("from", "", "Backup bundle path")
	preflightOnly := flags.Bool("preflight", false, "Validate the bundle without writing anything")
	force := flags.Bool("force", false, "Replace an existing project")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *from == "" {
		_, _ = fmt.Fprintln(stderr, "restore requires --from PATH")
		return 2
	}
	rootConfig := makeRootConfig(flags, rootPath, workingDirectory)
	root, err := project.ResolveRoot(rootConfig)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot resolve project root: %v\n", err)
		return 1
	}
	if err := os.MkdirAll(root.ManagedDir, 0o700); err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot prepare the project state directory: %v\n", err)
		return 1
	}
	service, err := portability.NewInspectionService(portability.InspectionOptions{ManagedDir: root.ManagedDir})
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot prepare preflight: %v\n", err)
		return 1
	}
	preflight, err := service.Preflight(context.Background(), *from)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "preflight failed: %v\n", err)
		return 1
	}
	encoded, err := json.Marshal(preflight)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot encode preflight result: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintln(stdout, string(encoded))
	if !preflight.Compatible {
		_, _ = fmt.Fprintln(stderr, "this bundle is not compatible with the running Runtime; nothing was written")
		return 1
	}
	if *preflightOnly {
		return 0
	}

	lock, err := project.AcquireRuntimeLock(root)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot restore while the project is in use: %v\n", err)
		return 1
	}
	defer lock.Release()
	if _, err := os.Stat(root.Database); err == nil && !*force {
		_, _ = fmt.Fprintln(stderr, "this project already contains state; pass --force to replace it")
		return 1
	}
	if _, err := service.Apply(context.Background(), *from, portability.ApplyOptions{
		Force: *force, DatabasePath: root.Database, ObjectsDir: root.Objects,
	}); err != nil {
		_, _ = fmt.Fprintf(stderr, "restore failed: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintf(stdout, "{\"restored\":%q,\"projectRoot\":%q}\n", *from, root.Path)
	return 0
}

func runGenerate(args []string, stdout, stderr io.Writer, workingDirectory string) int {
	flags := flag.NewFlagSet("generate", flag.ContinueOnError)
	flags.SetOutput(stderr)
	rootPath := flags.String("project-root", "", "Project Root directory")
	output := flags.String("out", "", "Output directory for generated artifacts")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *output == "" {
		_, _ = fmt.Fprintln(stderr, "generate requires --out DIR")
		return 2
	}
	rootConfig := makeRootConfig(flags, rootPath, workingDirectory)
	root, err := project.ResolveRoot(rootConfig)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot resolve project root: %v\n", err)
		return 1
	}
	store, err := storage.Open(root.Database)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot open project storage: %v\n", err)
		return 1
	}
	defer store.Close()
	models, err := backendmodel.NewService(context.Background(), store)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot open the Backend Model: %v\n", err)
		return 1
	}
	service, err := portability.NewInspectionService(portability.InspectionOptions{ManagedDir: root.ManagedDir, Models: models, Version: version})
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot prepare generation: %v\n", err)
		return 1
	}
	contract, err := service.BuildContract(context.Background(), nil)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot build the Application API contract: %v\n", err)
		return 1
	}
	artifacts, err := portability.GenerateArtifacts(contract)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot generate artifacts: %v\n", err)
		return 1
	}
	if err := os.MkdirAll(*output, 0o755); err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot prepare the output directory: %v\n", err)
		return 1
	}
	if err := os.WriteFile(filepath.Join(*output, "application-api.json"), artifacts.ContractJSON, 0o644); err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot write application-api.json: %v\n", err)
		return 1
	}
	if err := os.WriteFile(filepath.Join(*output, "modelry-client.ts"), artifacts.ClientTypeScript, 0o644); err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot write modelry-client.ts: %v\n", err)
		return 1
	}
	summary := map[string]any{"version": contract.Version, "contentHash": contract.ContentHash, "collections": len(contract.Collections), "output": *output}
	encoded, err := json.Marshal(summary)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot encode generation summary: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintln(stdout, string(encoded))
	return 0
}