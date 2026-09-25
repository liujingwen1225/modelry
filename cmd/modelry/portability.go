package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/extensions"
	"github.com/liujingwen1225/modelry/internal/filestore"
	"github.com/liujingwen1225/modelry/internal/portability"
	"github.com/liujingwen1225/modelry/internal/project"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// cliObjects 按 key 从项目当前启用的 Provider 读取对象。被引用的 key 集合来自
// Portability 对同一 SQLite snapshot 的读取；这里不再假设对象一定在 Local。
type cliObjects struct{ files *filestore.Service }

func (source cliObjects) OpenObject(ctx context.Context, key string) (io.ReadCloser, error) {
	provider, err := source.files.ActiveProvider(ctx)
	if err != nil {
		return nil, err
	}
	reader, _, err := provider.Open(ctx, key)
	return reader, err
}

type cliManifestSummary struct {
	Bundle         string `json:"bundle"`
	Bytes          int64  `json:"bytes"`
	Digest         string `json:"digest"`
	ProjectID      string `json:"projectId"`
	Collections    int64  `json:"collections"`
	Records        int64  `json:"records"`
	Objects        int64  `json:"objects"`
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
	// 一个半恢复的项目必须先用 restore 收敛；否则 storage.Open 会创建一个全新的空项目，
	// 并产出一份看起来合法、实际是空的备份。
	if err := portability.CheckInterruptedRestore(root.ManagedDir); err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot back up the project: %v\n", err)
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
	secrets, err := extensions.NewService(context.Background(), store, models, extensions.ServiceOptions{
		ManagedDir: root.ManagedDir, ProjectID: store.ProjectID(),
	})
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot open Project Secrets for backup: %v\n", err)
		return 1
	}
	defer secrets.Close(context.Background())
	files, err := newCLIFileStorage(root, store, models, secrets)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot prepare File Storage for backup: %v\n", err)
		return 1
	}
	service, err := portability.NewService(portability.Options{
		Store: store, Objects: cliObjects{files: files}, Models: models,
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

// newCLIFileStorage constructs the same persisted Provider and Secret boundary as Runtime,
// without starting the Runtime. In particular, an unavailable S3 provider remains an error;
// backup never falls back to the Local directory.
func newCLIFileStorage(root project.Root, store *storage.Store, models *backendmodel.Service, secrets filestore.SecretProvider) (*filestore.Service, error) {
	for _, directory := range []string{root.TempFiles, root.Objects} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, fmt.Errorf("prepare project File Storage directories: %w", err)
		}
	}
	ctx := context.Background()
	if secrets == nil {
		return nil, fmt.Errorf("Project Secret provider is required")
	}
	audits, err := audit.NewService(ctx, store)
	if err != nil {
		return nil, fmt.Errorf("open Audit storage: %w", err)
	}
	recordService, err := records.NewWithLocalFiles(store, models, root.TempFiles, root.Objects)
	if err != nil {
		return nil, fmt.Errorf("open Record File references: %w", err)
	}
	files, err := filestore.NewService(ctx, filestore.ServiceOptions{
		Store: store, Secrets: secrets, Audits: audits,
		References: recordService, Staging: recordService, ObjectsDir: root.Objects,
	})
	if err != nil {
		return nil, fmt.Errorf("open File Storage configuration: %w", err)
	}
	return files, nil
}

func runRestore(args []string, stdout, stderr io.Writer, workingDirectory string) int {
	flags := flag.NewFlagSet("restore", flag.ContinueOnError)
	flags.SetOutput(stderr)
	rootPath := flags.String("project-root", "", "Project Root directory")
	from := flags.String("from", "", "Backup bundle path")
	preflightOnly := flags.Bool("preflight", false, "Validate the bundle without writing anything")
	force := flags.Bool("force", false, "Replace an existing project")
	legacyResolution := flags.String("resolve-legacy-restore", "", "Explicitly accept current state in a pre-marker journal: accept-current")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *legacyResolution != "" && (!*force || *preflightOnly) {
		_, _ = fmt.Fprintln(stderr, "--resolve-legacy-restore requires an apply with --force")
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
	if *legacyResolution != "" {
		if err := portability.ResolveLegacyRestore(root.ManagedDir, portability.LegacyRestoreResolution(*legacyResolution)); err != nil {
			_, _ = fmt.Fprintf(stderr, "cannot resolve the legacy restore journal: %v\n", err)
			return 1
		}
	}
	// 「项目是否已有状态」由 Apply 在回滚掉任何残留的中间态之后判断，CLI 不重复判断：
	// 一个残留的 journal 可能短暂地让 project.sqlite 不存在，从而让 --force 这道门被绕过。
	if _, err := service.Apply(context.Background(), *from, portability.ApplyOptions{
		Force: *force, DatabasePath: root.Database, ObjectsDir: root.Objects,
	}); err != nil {
		if errors.Is(err, portability.ErrProjectNotEmpty) {
			_, _ = fmt.Fprintln(stderr, "this project already contains state; pass --force to replace it")
			return 1
		}
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
	// 与 Runtime 一致：一个半恢复的项目必须先用 restore 收敛。
	if err := portability.CheckInterruptedRestore(root.ManagedDir); err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot generate artifacts: %v\n", err)
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
