package runtime

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/project"
	"github.com/liujingwen1225/modelry/internal/storage"
	"github.com/liujingwen1225/modelry/internal/webui"
)

const drainWindow = 10 * time.Second

type Options struct {
	ProjectRoot project.RootConfig
	Version     string
}

type Runtime struct {
	root           project.Root
	lock           *project.RuntimeLock
	store          *storage.Store
	version        string
	databaseHealth string
	fileHealth     string
	mu             sync.RWMutex
	state          string
	listener       net.Listener
	server         *http.Server
	runStarted     bool
	closed         bool
	closeOnce      sync.Once
	closeErr       error
}

func New(options Options) (_ *Runtime, resultErr error) {
	root, err := project.ResolveRoot(options.ProjectRoot)
	if err != nil {
		return nil, err
	}
	lock, err := project.AcquireRuntimeLock(root)
	if err != nil {
		return nil, err
	}
	var store *storage.Store
	defer func() {
		if resultErr != nil {
			if store != nil {
				resultErr = errors.Join(resultErr, store.Close())
			}
			resultErr = errors.Join(resultErr, lock.Release())
		}
	}()

	for _, directory := range []string{root.TempFiles, root.Objects} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, fmt.Errorf("cannot prepare Modelry Local Storage directory %q: %w", directory, err)
		}
	}
	store, err = storage.Open(root.Database)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry SQLite storage: %w", err)
	}
	if err := probeLocalStorage(root.TempFiles); err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Local Storage: %w", err)
	}
	if err := webui.Validate(); err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Admin HTTP module: %w", err)
	}
	version := options.Version
	if version == "" {
		version = "dev"
	}
	instance := &Runtime{
		root:           root,
		lock:           lock,
		store:          store,
		version:        version,
		databaseHealth: "ready",
		fileHealth:     "ready",
		state:          "starting",
	}
	instance.server = &http.Server{
		Handler:           httpapi.NewHandler(instance, webui.Handler()),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	return instance, nil
}

func (instance *Runtime) Run(ctx context.Context, listenAddress string, onReady func(net.Addr)) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return errors.Join(err, instance.Close())
	}
	instance.mu.Lock()
	if instance.runStarted || instance.closed || instance.server == nil {
		instance.mu.Unlock()
		return errors.New("Modelry Runtime can only be served once")
	}
	instance.runStarted = true
	instance.mu.Unlock()

	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		instance.setState("unavailable")
		return errors.Join(fmt.Errorf("cannot bind Modelry HTTP listener at %q: %w", listenAddress, err), instance.Close())
	}
	instance.mu.Lock()
	instance.listener = listener
	instance.state = "ready"
	server := instance.server
	instance.mu.Unlock()

	serveResult := make(chan error, 1)
	go func() {
		serveResult <- server.Serve(listener)
	}()
	if onReady != nil {
		onReady(listener.Addr())
	}

	var runErr error
	serveReturned := false
	select {
	case serveErr := <-serveResult:
		serveReturned = true
		if !errors.Is(serveErr, http.ErrServerClosed) {
			runErr = serveErr
		}
	case <-ctx.Done():
	}
	closeErr := instance.Close()
	if runErr == nil && ctx.Err() == nil {
		runErr = errors.New("Modelry HTTP server stopped unexpectedly")
	}
	if !serveReturned {
		select {
		case serveErr := <-serveResult:
			if !errors.Is(serveErr, http.ErrServerClosed) {
				runErr = errors.Join(runErr, serveErr)
			}
		case <-time.After(time.Second):
			runErr = errors.Join(runErr, errors.New("HTTP listener did not stop after graceful shutdown"))
		}
	}
	return errors.Join(runErr, closeErr)
}

func (instance *Runtime) Close() error {
	if instance == nil {
		return nil
	}
	instance.closeOnce.Do(func() {
		instance.mu.Lock()
		instance.state = "stopping"
		instance.closed = true
		instance.mu.Unlock()
		var serverErr error
		if instance.server != nil {
			ctx, cancel := context.WithTimeout(context.Background(), drainWindow)
			serverErr = instance.server.Shutdown(ctx)
			cancel()
			if serverErr != nil {
				serverErr = errors.Join(serverErr, instance.server.Close())
			}
		}
		var storageErr error
		if instance.store != nil {
			storageErr = instance.store.Close()
		}
		var lockErr error
		if instance.lock != nil {
			lockErr = instance.lock.Release()
		}
		instance.closeErr = errors.Join(serverErr, storageErr, lockErr)
	})
	return instance.closeErr
}

func (instance *Runtime) RuntimeStatus() httpapi.RuntimeStatusResponse {
	instance.refreshHealth()
	instance.mu.RLock()
	state := instance.state
	databaseState := instance.databaseHealth
	fileState := instance.fileHealth
	instance.mu.RUnlock()
	return httpapi.RuntimeStatusResponse{
		State:      state,
		ObservedAt: time.Now().UTC(),
		Database: httpapi.Health{
			State:   databaseState,
			Message: healthMessage("SQLite database", databaseState),
		},
		LocalStorage: httpapi.Health{
			State:   fileState,
			Message: healthMessage("Local Storage", fileState),
		},
		ProjectSource: string(instance.root.Source),
		Version:       instance.version,
	}
}

func (instance *Runtime) StorageStatus() httpapi.StorageStatusResponse {
	instance.refreshHealth()
	instance.mu.RLock()
	databaseState := instance.databaseHealth
	fileState := instance.fileHealth
	instance.mu.RUnlock()
	return httpapi.StorageStatusResponse{
		Database: httpapi.Health{
			State:   databaseState,
			Message: healthMessage("SQLite database", databaseState),
		},
		LocalStorage: httpapi.LocalStorageHealth{
			State:    fileState,
			Message:  healthMessage("Local Storage", fileState),
			Provider: "Local",
		},
	}
}

func (instance *Runtime) ProjectID() string {
	if instance == nil || instance.store == nil {
		return ""
	}
	return instance.store.ProjectID()
}

func (instance *Runtime) Root() project.Root {
	if instance == nil {
		return project.Root{}
	}
	return instance.root
}

func (instance *Runtime) SQLiteVersion() string {
	if instance == nil || instance.store == nil {
		return ""
	}
	return instance.store.SQLiteVersion()
}

func (instance *Runtime) setState(state string) {
	instance.mu.Lock()
	instance.state = state
	instance.mu.Unlock()
}

func (instance *Runtime) refreshHealth() {
	if instance == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	databaseState := "ready"
	if err := instance.store.Ping(ctx); err != nil {
		databaseState = "unavailable"
	}
	cancel()
	fileState := "ready"
	if err := probeLocalStorage(instance.root.TempFiles); err != nil {
		fileState = "unavailable"
	}
	instance.mu.Lock()
	instance.databaseHealth = databaseState
	instance.fileHealth = fileState
	if instance.listener != nil && (instance.state == "ready" || instance.state == "degraded") {
		if databaseState == "ready" && fileState == "ready" {
			instance.state = "ready"
		} else {
			instance.state = "degraded"
		}
	}
	instance.mu.Unlock()
}

func healthMessage(name, state string) string {
	if state == "ready" {
		return name + " is ready."
	}
	return name + " is unavailable."
}

func probeLocalStorage(directory string) error {
	file, err := os.CreateTemp(directory, ".modelry-ready-*")
	if err != nil {
		return err
	}
	name := file.Name()
	if _, err := file.Write([]byte{0}); err != nil {
		_ = file.Close()
		_ = os.Remove(name)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(name)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Remove(name); err != nil {
		return fmt.Errorf("cannot remove Local Storage readiness probe %q: %w", filepath.Base(name), err)
	}
	return nil
}
