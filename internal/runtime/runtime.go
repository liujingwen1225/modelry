package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/liujingwen1225/modelry/internal/accesscontrol"
	"github.com/liujingwen1225/modelry/internal/activity"
	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/drift"
	"github.com/liujingwen1225/modelry/internal/runtimesettings"
	"github.com/liujingwen1225/modelry/internal/appauth"
	"github.com/liujingwen1225/modelry/internal/applicationapi"
	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/automation"
	"github.com/liujingwen1225/modelry/internal/backendapi"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/diagnostics"
	"github.com/liujingwen1225/modelry/internal/extensions"
	"github.com/liujingwen1225/modelry/internal/filestore"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/mail"
	"github.com/liujingwen1225/modelry/internal/project"
	"github.com/liujingwen1225/modelry/internal/realtimeapi"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/recordlifecycle"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/requests"
	"github.com/liujingwen1225/modelry/internal/serviceaccounts"
	"github.com/liujingwen1225/modelry/internal/storage"
	"github.com/liujingwen1225/modelry/internal/webui"
)

const (
	drainWindow = 10 * time.Second
	// stagingReconcileGrace 是未绑定暂存上传的最短保留时间。
	stagingReconcileGrace = 15 * time.Minute
	// objectReconcileGrace 是未被引用对象的最短保留时间。
	objectReconcileGrace = time.Hour
)

type Options struct {
	ProjectRoot project.RootConfig
	Version     string
	// ListenFlag 只在 --listen 被显式提供时非空；它优先于 Project Runtime Settings。
	ListenFlag string
	// ListenDefault 是既没有 flag 也没有 Project 取值时使用的内建默认值。
	ListenDefault string
}

type Runtime struct {
	root           project.Root
	lock           *project.RuntimeLock
	store          *storage.Store
	events         *recordevents.Service
	extensions     *extensions.Service
	automation     *automation.Service
	files          *filestore.Service
	mail           *mail.Service
	activity       *activity.Service
	drift          *drift.Service
	settings       *runtimesettings.Service
	requests       *requests.Service
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
	var extensionService *extensions.Service
	var automationService *automation.Service
	var fileService *filestore.Service
	var mailService *mail.Service
	defer func() {
		if resultErr != nil {
			if automationService != nil {
				resultErr = errors.Join(resultErr, automationService.Close(context.Background()))
			}
			if fileService != nil {
				resultErr = errors.Join(resultErr, fileService.Close(context.Background()))
			}
			if mailService != nil {
				resultErr = errors.Join(resultErr, mailService.Close(context.Background()))
			}
			if extensionService != nil {
				resultErr = errors.Join(resultErr, extensionService.Close(context.Background()))
			}
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
	ownerAuth, err := adminauth.New(store)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Owner authentication: %w", err)
	}
	backendModel, err := backendmodel.NewService(context.Background(), store)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Backend Model: %w", err)
	}
	accessRules, err := accesscontrol.NewService(context.Background(), store, backendModel)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Access Rules: %w", err)
	}
	eventService, err := recordevents.NewService(context.Background(), store)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Record Events: %w", err)
	}
	extensionService, err = extensions.NewService(context.Background(), store, backendModel, extensions.ServiceOptions{
		ManagedDir: root.ManagedDir,
		ProjectID:  store.ProjectID(),
		Invoker:    extensions.HookInvoker{},
	})
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Extension Runtime: %w", err)
	}
	auditService, err := audit.NewService(context.Background(), store)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Audit History: %w", err)
	}
	// Administrator 生命周期审计通过注入的 AuditSink 写入，避免 adminauth 依赖 Audit 包。
	ownerAuth.SetAuditSink(adminAuthAuditSink{audits: auditService})
	automationService, err = newAutomationService(context.Background(), store, extensionService, auditService)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Webhooks and Jobs: %w", err)
	}
	extensionService.SetSecretRevocationObserver(automationService)
	recordService, err := records.NewWithLocalFiles(store, backendModel, root.TempFiles, root.Objects, records.WithAuthorization(accessRules, nil), records.WithRecordEvents(eventService), records.WithLifecycleHooks(recordlifecycle.Combine(extensionService.LifecycleHooks(), automationService)))
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Records and Local Files: %w", err)
	}
	fileService, err = filestore.NewService(context.Background(), filestore.ServiceOptions{
		Store: store, Secrets: extensionService, Audits: auditService,
		References: recordService, Staging: recordService, ObjectsDir: root.Objects,
	})
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry File Storage: %w", err)
	}
	// Records 通过注入的解析器读取当前 Provider；配置切换不需要重建 Records Service。
	recordService.SetFileProviders(fileService)
	authService, err := appauth.NewService(context.Background(), store, backendModel, recordService)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Application authentication: %w", err)
	}
	// Mail outbox 复用 App Auth 的投递正文渲染；App Auth 通过适配器在自身事务内写入投递意图。
	mailService, err = mail.NewService(context.Background(), mail.ServiceOptions{
		Store: store, Secrets: extensionService, Payloads: mailPayloadAdapter{service: authService},
		Audits: mailAuditSink{audits: auditService},
	})
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Mail delivery: %w", err)
	}
	authService.SetRecoveryDependencies(mailEnqueuerAdapter{service: mailService}, extensionService, authAuditSink{audits: auditService})
	requestService, err := requests.NewService(context.Background(), store)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Request History: %w", err)
	}
	// Runtime Settings 是 Runtime 自身的 durable 配置；它不属于 Backend Model。
	settingsService, err := runtimesettings.NewService(context.Background(), store, runtimesettings.Options{
		DefaultListenAddress: defaultListenAddress(options), FlagListenAddress: options.ListenFlag,
	}, settingsAuditSink{audits: auditService})
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Runtime Settings: %w", err)
	}
	// Drift Detection 比较 Applied Model、物理投影与 runtime-managed state。
	driftService, err := drift.NewService(store, backendModel, driftAuditSink{audits: auditService})
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Drift Detection: %w", err)
	}
	// Activity 只读取各子系统自己拥有的事实。
	activityService, err := activity.NewService(store,
		activityFactsFunc(backendModel.ActivityFacts), activityFactsFunc(automationService.ActivityFacts),
		activityFactsFunc(extensionService.ActivityFacts), activityFactsFunc(mailService.ActivityFacts),
		activityFactsFunc(fileService.ActivityFacts), activityFactsFunc(authService.ActivityFacts))
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Activity: %w", err)
	}
	accessRules.SetSimulationRecordLookup(simulationRecordLookup{records: recordService})
	serviceAccountService, err := serviceaccounts.NewService(context.Background(), store, auditService)
	if err != nil {
		return nil, fmt.Errorf("cannot initialize Modelry Service Accounts: %w", err)
	}
	if err := recordService.ReconcileStaging(context.Background(), stagingReconcileGrace); err != nil {
		return nil, fmt.Errorf("cannot reconcile Modelry staged uploads: %w", err)
	}
	// Provider 不可用时 Runtime 仍必须启动：诊断会显示 degraded，文件操作 fail closed。
	_ = fileService.Reconcile(context.Background(), objectReconcileGrace)
	for _, directory := range []string{root.TempFiles, root.Objects} {
		if err := probeLocalStorage(directory); err != nil {
			return nil, fmt.Errorf("cannot initialize Modelry Local Storage: %w", err)
		}
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
		events:         eventService,
		extensions:     extensionService,
		automation:     automationService,
		files:          fileService,
		mail:           mailService,
		activity:       activityService,
		drift:          driftService,
		settings:       settingsService,
		requests:       requestService,
		version:        version,
		databaseHealth: "ready",
		fileHealth:     "ready",
		state:          "starting",
	}
	rawAdminAPI := httpapi.NewAPIRouter(
		ownerAuth,
		httpapi.NewDiagnosticsModule(instance, func(ctx context.Context) bool {
			_, owner := adminauth.OwnerFromContext(ctx)
			return owner || serviceaccounts.HasPermission(ctx, serviceaccounts.OperationStorageRead)
		}),
		backendapi.NewModule(backendModel, func(ctx context.Context, tx storage.Executor, collection backendmodel.Collection, configuration backendapi.InitialConfiguration) error {
			var initialAuthentication *appauth.AuthConfig
			if len(configuration.Authentication) > 0 {
				var value appauth.AuthConfig
				if err := json.Unmarshal(configuration.Authentication, &value); err != nil {
					return backendmodel.ErrInvalidArgument
				}
				initialAuthentication = &value
			}
			if err := appauth.InitializeCollection(ctx, tx, collection, initialAuthentication); err != nil {
				return err
			}
			var initialRules []accesscontrol.Rule
			if len(configuration.AccessRules) > 0 {
				if err := json.Unmarshal(configuration.AccessRules, &initialRules); err != nil {
					return backendmodel.ErrInvalidArgument
				}
			}
			return accesscontrol.InitializeCollection(ctx, tx, collection, initialRules)
		}),
		accesscontrol.NewModule(accessRules),
		automation.NewModule(automationService),
		filestore.NewModule(fileService),
		extensions.NewModule(extensionService),
		appauth.NewModule(authService),
		applicationapi.NewModule(backendModel, recordService, applicationapi.WithSessionAuthenticator(authService)),
		realtimeapi.NewModule(backendModel, eventService, accessRules, authService),
		recordService,
		requests.NewModule(requestService),
		mail.NewModule(mailService),
		activity.NewModule(activityService),
		drift.NewModule(driftService),
		runtimesettings.NewModule(settingsService),
		serviceaccounts.NewModule(serviceAccountService),
		audit.NewModule(auditService),
	)
	ownerProtectedAPI := ownerAuth.Middleware(rawAdminAPI)
	serviceAccountProtectedAPI := serviceAccountService.ServiceAccountMiddleware(ownerProtectedAPI, rawAdminAPI)
	instance.server = &http.Server{
		Handler: httpapi.NewHandler(
			instance,
			webui.Handler(),
			requestService.Middleware(serviceAccountProtectedAPI),
		),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	return instance, nil
}

// ListenAddress 返回当前生效的监听地址：显式 flag 优先于 Project Runtime Settings，
// 两者都没有时使用内建默认值。
func (instance *Runtime) ListenAddress(ctx context.Context) string {
	if instance == nil {
		return ""
	}
	if instance.settings != nil {
		if settings, err := instance.settings.Get(ctx); err == nil && settings.ListenAddress.Value != "" {
			return settings.ListenAddress.Value
		}
	}
	return defaultListenAddress(Options{})
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
	// 记录本次进程实际使用的监听值，用于判断 Runtime Settings 是否需要重启。
	if instance.settings != nil {
		instance.settings.SetRunningListen(listenAddress)
	}
	if instance.requests != nil && instance.settings != nil {
		if err := instance.requests.StartRetention(ctx, func(sourceCtx context.Context) (int, error) {
			current, err := instance.settings.Get(sourceCtx)
			if err != nil {
				return 0, err
			}
			return current.RequestRetentionDaysValue(), nil
		}); err != nil {
			instance.setState("unavailable")
			return errors.Join(fmt.Errorf("cannot start Modelry Request retention: %w", err), instance.Close())
		}
	}
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
	if instance.automation != nil {
		if err := instance.automation.Start(ctx); err != nil {
			instance.setState("unavailable")
			return errors.Join(fmt.Errorf("cannot start Modelry Webhooks and Jobs dispatcher: %w", err), instance.Close())
		}
	}
	if instance.files != nil {
		if err := instance.files.Start(ctx); err != nil {
			instance.setState("unavailable")
			return errors.Join(fmt.Errorf("cannot start Modelry File Storage reconciliation: %w", err), instance.Close())
		}
	}
	if instance.mail != nil {
		if err := instance.mail.Start(ctx); err != nil {
			instance.setState("unavailable")
			return errors.Join(fmt.Errorf("cannot start Modelry Mail outbox: %w", err), instance.Close())
		}
	}

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
		var automationErr error
		if instance.automation != nil {
			ctx, cancel := context.WithTimeout(context.Background(), drainWindow)
			automationErr = instance.automation.Close(ctx)
			cancel()
		}
		var mailErr error
		if instance.mail != nil {
			ctx, cancel := context.WithTimeout(context.Background(), drainWindow)
			mailErr = instance.mail.Close(ctx)
			cancel()
		}
		var retentionErr error
		if instance.requests != nil {
			ctx, cancel := context.WithTimeout(context.Background(), drainWindow)
			retentionErr = instance.requests.CloseRetention(ctx)
			cancel()
		}
		var filesErr error
		if instance.files != nil {
			ctx, cancel := context.WithTimeout(context.Background(), drainWindow)
			filesErr = instance.files.Close(ctx)
			cancel()
		}
		var extensionErr error
		if instance.extensions != nil {
			ctx, cancel := context.WithTimeout(context.Background(), drainWindow)
			extensionErr = instance.extensions.Close(ctx)
			cancel()
		}
		if instance.events != nil {
			instance.events.Close()
		}
		var storageErr error
		if instance.store != nil {
			storageErr = instance.store.Close()
		}
		var lockErr error
		if instance.lock != nil {
			lockErr = instance.lock.Release()
		}
		instance.closeErr = errors.Join(serverErr, automationErr, retentionErr, filesErr, mailErr, extensionErr, storageErr, lockErr)
	})
	return instance.closeErr
}

func (instance *Runtime) RuntimeStatus() diagnostics.RuntimeStatus {
	instance.refreshHealth()
	instance.mu.RLock()
	state := instance.state
	databaseState := instance.databaseHealth
	fileState := instance.fileHealth
	instance.mu.RUnlock()
	return diagnostics.RuntimeStatus{
		State:      state,
		ObservedAt: time.Now().UTC(),
		Database: diagnostics.Health{
			State:   databaseState,
			Message: healthMessage("SQLite database", databaseState),
		},
		LocalStorage: diagnostics.Health{
			State:   fileState,
			Message: healthMessage("Local Storage", fileState),
		},
		ProjectSource: string(instance.root.Source),
		Version:       instance.version,
	}
}

func (instance *Runtime) StorageStatus() diagnostics.StorageStatus {
	instance.refreshHealth()
	instance.mu.RLock()
	databaseState := instance.databaseHealth
	fileState := instance.fileHealth
	instance.mu.RUnlock()
	return diagnostics.StorageStatus{
		Database: diagnostics.Health{
			State:   databaseState,
			Message: healthMessage("SQLite database", databaseState),
		},
		LocalStorage: diagnostics.LocalStorageStatus{
			State:    fileState,
			Message:  healthMessage("Local Storage", fileState),
			Provider: "Local",
			Path:     instance.root.Files,
		},
		FileStorage: instance.fileStorageStatus(),
	}
}

// fileStorageStatus 返回 Provider 中立的活动 Provider 健康快照。
// 它不返回 endpoint、桶名、对象引用或任何凭据。
func (instance *Runtime) fileStorageStatus() diagnostics.FileStorageStatus {
	if instance.files == nil {
		return diagnostics.FileStorageStatus{State: "unknown", ActiveProvider: "local", Provider: "Local", Message: "File Storage is not initialized."}
	}
	kind, health := instance.files.ProviderHealth(context.Background())
	return diagnostics.FileStorageStatus{
		State: health.State, Provider: filestore.ProviderLabel(kind), ActiveProvider: string(kind),
		Message: health.Message, Hint: health.Hint,
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
	for _, directory := range []string{instance.root.TempFiles, instance.root.Objects} {
		if err := probeLocalStorage(directory); err != nil {
			fileState = "unavailable"
			break
		}
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
