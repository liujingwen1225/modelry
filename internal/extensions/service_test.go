package extensions

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/recordlifecycle"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

type invocationFunc func(context.Context, Invocation) (json.RawMessage, error)

func (function invocationFunc) Invoke(ctx context.Context, invocation Invocation) (json.RawMessage, error) {
	return function(ctx, invocation)
}

type secretDeletionProbe struct {
	fail        error
	transaction bool
	committed   bool
}

func (probe *secretDeletionProbe) RevokeSecretInTransaction(ctx context.Context, tx storage.Executor, secretID string) error {
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_secrets WHERE id=?`, secretID).Scan(&exists); err != nil {
		return err
	}
	probe.transaction = true
	if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_secret_delete_probe(secret_id) VALUES(?)`, secretID); err != nil {
		return err
	}
	return probe.fail
}

func (probe *secretDeletionProbe) SecretRevoked(string) { probe.committed = true }

type extensionFixture struct {
	root    string
	managed string
	store   *storage.Store
	models  *backendmodel.Service
	events  *recordevents.Service
	service *Service
}

func newExtensionFixture(t *testing.T, invoker Invoker) *extensionFixture {
	t.Helper()
	root := t.TempDir()
	managed := filepath.Join(root, ".modelry")
	if err := os.Mkdir(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(filepath.Join(managed, "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	models, err := backendmodel.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	events, err := recordevents.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(context.Background(), store, models, ServiceOptions{ManagedDir: managed, ProjectID: store.ProjectID(), Invoker: invoker})
	if err != nil {
		t.Fatal(err)
	}
	fixture := &extensionFixture{root: root, managed: managed, store: store, models: models, events: events, service: service}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := service.Close(ctx); err != nil {
			t.Errorf("close Extension service: %v", err)
		}
		events.Close()
		if err := store.Close(); err != nil {
			t.Errorf("close SQLite store: %v", err)
		}
	})
	return fixture
}

func TestExtensionRevisionReplacementIsValidatedAndBindingEnableIsAtomic(t *testing.T) {
	ctx := context.Background()
	fixture := newExtensionFixture(t, nil)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Profiles", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	first, err := fixture.service.Create(ctx, ConfigInput{Name: "Normalize", Language: LanguageJavaScript, Source: `export function beforeCreate() { return { action: "allow" }; }`})
	if err != nil {
		t.Fatal(err)
	}
	first, err = fixture.service.Replace(ctx, first.ID, ConfigInput{Name: first.Name, Language: first.Language, Source: `export function beforeCreate() { return { action: "allow" }; }`, Bindings: []Binding{{CollectionID: collection.ID, Operation: OperationCreate, Phase: PhaseBefore}}})
	if err != nil {
		t.Fatal(err)
	}
	if enabled, err := fixture.service.Enable(ctx, first.ID); err != nil || !enabled {
		t.Fatalf("enable Extension = %v, %v", enabled, err)
	}
	second, err := fixture.service.Create(ctx, ConfigInput{Name: "Other", Language: LanguageTypeScript, Source: `export function beforeCreate() { return { action: "allow" }; }`})
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.service.Replace(ctx, second.ID, ConfigInput{Name: second.Name, Language: second.Language, Source: `export function beforeCreate() { return { action: "allow" }; }`, Bindings: []Binding{{CollectionID: collection.ID, Operation: OperationCreate, Phase: PhaseBefore}}})
	if err != nil {
		t.Fatal(err)
	}
	if enabled, err := fixture.service.Enable(ctx, second.ID); !errors.Is(err, ErrBindingConflict) || enabled {
		t.Fatalf("conflicting enable = %v, %v; want disabled Binding conflict", enabled, err)
	}
	unchanged, err := fixture.service.Get(ctx, second.ID)
	if err != nil || unchanged.Enabled || unchanged.ActiveRevision != 1 {
		t.Fatalf("conflicting enable changed Extension state: detail=%+v err=%v", unchanged, err)
	}

	if _, err := fixture.service.Replace(ctx, first.ID, ConfigInput{Name: first.Name, Language: first.Language, Source: `export function beforeCreate( {`, Bindings: first.Bindings}); !errors.Is(err, ErrValidation) {
		t.Fatalf("invalid source replacement error = %v, want safe validation error", err)
	}
	stillActive, err := fixture.service.Get(ctx, first.ID)
	if err != nil || stillActive.ActiveRevision != 1 || stillActive.Source != first.Source || !stillActive.Enabled {
		t.Fatalf("invalid replacement changed active Extension: detail=%+v err=%v", stillActive, err)
	}
}

func TestExtensionBindingCountMatchesOpenAPIContract(t *testing.T) {
	bindings := make([]Binding, maxBindingsPerExtension+1)
	for index := range bindings {
		bindings[index] = Binding{
			CollectionID: "collection_" + string(rune('a'+index)),
			Operation:    OperationCreate,
			Phase:        PhaseBefore,
		}
	}
	_, _, err := validateConfig(ConfigInput{
		Name: "Too many bindings", Language: LanguageJavaScript,
		Source:   `export function beforeCreate() { return { action: "allow" }; }`,
		Bindings: bindings,
	}, true)
	var validation *ValidationError
	if !errors.As(err, &validation) || len(validation.Violations) != 1 || validation.Violations[0].Path != "/bindings" || validation.Violations[0].Code != "tooManyBindings" {
		t.Fatalf("too many Bindings error = %#v, want /bindings tooManyBindings", err)
	}
}

func TestSecretIsEncryptedWriteOnlyAndMissingKeyFailsClosed(t *testing.T) {
	ctx := context.Background()
	fixture := newExtensionFixture(t, nil)
	secretValue := "never-store-this-secret-value"
	secret, err := fixture.service.CreateSecret(ctx, "Mail API Key", secretValue)
	if err != nil {
		t.Fatal(err)
	}
	if !secret.Configured {
		t.Fatalf("created Secret is not marked configured: %+v", secret)
	}
	key, err := os.ReadFile(filepath.Join(fixture.managed, "secrets.key"))
	if err != nil || len(key) != 32 {
		t.Fatalf("Secret key file size = %d, err=%v", len(key), err)
	}
	var ciphertext []byte
	if err := fixture.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT value_cipher FROM modelry_secrets WHERE id=?`, secret.ID).Scan(&ciphertext)
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(ciphertext), secretValue) {
		t.Fatal("Secret value was stored as plaintext")
	}
	listed, err := fixture.service.ListSecrets(ctx)
	if err != nil || len(listed) != 1 || listed[0].ID != secret.ID || !listed[0].Configured {
		t.Fatalf("list Secrets = %+v, %v", listed, err)
	}
	serialized, err := json.Marshal(listed)
	if err != nil || strings.Contains(string(serialized), secretValue) || strings.Contains(string(serialized), string(ciphertext)) {
		t.Fatalf("Secret listing leaked value or ciphertext: %s, %v", serialized, err)
	}
	if err := os.Remove(filepath.Join(fixture.managed, "secrets.key")); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.ReplaceSecretValue(ctx, secret.ID, "rotated-value"); !errors.Is(err, ErrSecretKeyUnavailable) {
		t.Fatalf("replace with missing key error = %v, want fail-closed key error", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.managed, "secrets.key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing key was unexpectedly replaced: stat error = %v", err)
	}
}

func TestSecretValueIsAvailableOnlyInsideClearedCallbackAndDeletionJoinsTransaction(t *testing.T) {
	ctx := context.Background()
	fixture := newExtensionFixture(t, nil)
	secret, err := fixture.service.CreateSecret(ctx, "delivery signer", "signature-secret")
	if err != nil {
		t.Fatal(err)
	}
	name, configured, err := fixture.service.SecretMetadata(ctx, secret.ID)
	if err != nil || name != "delivery signer" || !configured {
		t.Fatalf("SecretMetadata() = %q, %t, %v", name, configured, err)
	}
	var plaintext []byte
	if err := fixture.service.WithSecretValue(ctx, secret.ID, func(value []byte) error {
		plaintext = value
		if string(value) != "signature-secret" {
			return errors.New("callback received the wrong Secret")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Trim(string(plaintext), "\x00") != "" {
		t.Fatal("Secret plaintext was not cleared after its callback returned")
	}

	if err := fixture.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `CREATE TABLE modelry_secret_delete_probe(secret_id TEXT PRIMARY KEY)`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	probe := &secretDeletionProbe{fail: errors.New("rollback Secret deletion")}
	fixture.service.SetSecretRevocationObserver(probe)
	if err := fixture.service.DeleteSecret(ctx, secret.ID); !errors.Is(err, probe.fail) {
		t.Fatalf("DeleteSecret() error = %v, want observer transaction failure", err)
	}
	if !probe.transaction || probe.committed {
		t.Fatalf("observer callbacks were not ordered around commit: %+v", probe)
	}
	if _, configured, err := fixture.service.SecretMetadata(ctx, secret.ID); err != nil || !configured {
		t.Fatalf("Secret was deleted despite transaction rollback: configured=%t err=%v", configured, err)
	}
	probe.fail = nil
	if err := fixture.service.DeleteSecret(ctx, secret.ID); err != nil {
		t.Fatal(err)
	}
	if !probe.committed {
		t.Fatal("SecretRevoked was not called after the Secret deletion committed")
	}
	if _, configured, err := fixture.service.SecretMetadata(ctx, secret.ID); err != nil || configured {
		t.Fatalf("deleted Secret metadata = configured %t, err %v", configured, err)
	}
}

func TestSecretNamesAreUnicodeCaseInsensitive(t *testing.T) {
	ctx := context.Background()
	fixture := newExtensionFixture(t, nil)
	first, err := fixture.service.CreateSecret(ctx, "Äpi", "first-secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.CreateSecret(ctx, "äPI", "second-secret"); !errors.Is(err, ErrValidation) {
		t.Fatalf("case-folded duplicate Secret name error = %v, want validation error", err)
	} else {
		var validation *ValidationError
		if !errors.As(err, &validation) || len(validation.Violations) != 1 || validation.Violations[0].Path != "/name" || validation.Violations[0].Code != "duplicateName" {
			t.Fatalf("duplicate Secret name details = %+v", validation)
		}
	}
	second, err := fixture.service.CreateSecret(ctx, "Another", "third-secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.RenameSecret(ctx, second.ID, "äpi"); !errors.Is(err, ErrValidation) {
		t.Fatalf("renamed case-folded duplicate Secret name error = %v, want validation error", err)
	}
	secrets, err := fixture.service.ListSecrets(ctx)
	if err != nil || len(secrets) != 2 || secrets[0].ID == "" || first.ID == "" {
		t.Fatalf("duplicate Secret name changed stored metadata: %+v, %v", secrets, err)
	}
}

func TestSecretNameKeyMigrationBackfillsExistingRows(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(filepath.Join(t.TempDir(), "legacy.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close legacy SQLite store: %v", err)
		}
	})
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE modelry_secrets (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE)`); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_secrets(id,name) VALUES('sec_legacy','Äpi')`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error { return ensureSecretNameKey(ctx, tx) }); err != nil {
		t.Fatalf("migrate legacy Secret names: %v", err)
	}
	var name, key string
	if err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT name,name_key FROM modelry_secrets WHERE id='sec_legacy'`).Scan(&name, &key)
	}); err != nil {
		t.Fatal(err)
	}
	if name != "Äpi" || key != secretNameKey("äPI") {
		t.Fatalf("migrated Secret name/key = %q/%q", name, key)
	}
}

func TestLifecycleBeforeAndAfterHooksUseRecordEventsAndSafeRunHistory(t *testing.T) {
	ctx := context.Background()
	var mu sync.Mutex
	var phases []string
	var afterStarted = make(chan struct{}, 1)
	invoker := invocationFunc(func(_ context.Context, invocation Invocation) (json.RawMessage, error) {
		mu.Lock()
		phases = append(phases, invocation.Phase)
		mu.Unlock()
		if invocation.Phase == "beforeCreate" {
			return json.RawMessage(`{"action":"allow","values":{"title":"normalized"}}`), nil
		}
		var input map[string]any
		if err := json.Unmarshal(invocation.Context, &input); err != nil || input["eventId"] == "" || invocation.SecretLookup == nil || invocation.HTTPRequest != nil {
			t.Errorf("unexpected After Hook boundary: input=%s err=%v", invocation.Context, err)
		}
		afterStarted <- struct{}{}
		return nil, nil
	})
	fixture := newExtensionFixture(t, invoker)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Notes", Type: backendmodel.CollectionTypeNormal, Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}}})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := fixture.service.Create(ctx, ConfigInput{Name: "Record lifecycle", Language: LanguageTypeScript, Source: `export function beforeCreate() { return { action: "allow" }; } export function afterCommitCreate() {}`})
	if err != nil {
		t.Fatal(err)
	}
	detail, err = fixture.service.Replace(ctx, detail.ID, ConfigInput{
		Name: detail.Name, Language: detail.Language, Source: detail.Source,
		Bindings: []Binding{{CollectionID: collection.ID, Operation: OperationCreate, Phase: PhaseBefore}, {CollectionID: collection.ID, Operation: OperationCreate, Phase: PhaseAfterCommit}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Enable(ctx, detail.ID); err != nil {
		t.Fatal(err)
	}
	recordService, err := records.New(fixture.store, fixture.models, records.WithRecordEvents(fixture.events), records.WithLifecycleHooks(fixture.service))
	if err != nil {
		t.Fatal(err)
	}
	created, err := recordService.Create(ctx, collection.ID, map[string]any{"title": "original"})
	if err != nil {
		t.Fatal(err)
	}
	if created.Values["title"] != "normalized" {
		t.Fatalf("Before Hook replacement was not persisted: %#v", created.Values)
	}
	select {
	case <-afterStarted:
	case <-time.After(time.Second):
		t.Fatal("After Hook did not start after commit")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		page, err := fixture.service.ListRuns(ctx, detail.ID, RunListOptions{Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Data) == 2 && page.Data[0].Status == RunSucceeded && page.Data[1].Status == RunSucceeded {
			if page.Data[0].EventID == "" || page.Data[0].RecordID != created.ID {
				t.Fatalf("After Hook Run lacks committed Event/Record context: %+v", page.Data[0])
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	page, err := fixture.service.ListRuns(ctx, detail.ID, RunListOptions{Limit: 10})
	if err != nil || len(page.Data) != 2 || page.Data[0].Status != RunSucceeded || page.Data[1].Status != RunSucceeded {
		t.Fatalf("Hook Runs did not finish safely: page=%+v err=%v", page, err)
	}
	for _, run := range page.Data {
		correlation := strings.TrimPrefix(run.CorrelationID, "cor_")
		if run.ErrorCode != "none" || len(correlation) != 36 {
			t.Fatalf("successful Hook Run category/ID = %q/%q, want none and cor_ plus 36 hex characters", run.ErrorCode, run.CorrelationID)
		}
		if _, err := hex.DecodeString(correlation); err != nil {
			t.Fatalf("Hook Run correlation ID is not lowercase hexadecimal: %q", run.CorrelationID)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(phases) != 2 || phases[0] != "beforeCreate" || phases[1] != "afterCommitCreate" {
		t.Fatalf("Hook invocation order/phases = %v", phases)
	}
}

func TestAfterCommitInvalidPersistedPinsBecomeTerminalFailure(t *testing.T) {
	ctx := context.Background()
	fixture := newExtensionFixture(t, nil)
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Pinned", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := fixture.service.Create(ctx, ConfigInput{Name: "Pinned hook", Language: LanguageJavaScript, Source: `export function afterCommitCreate() {}`})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Replace(ctx, detail.ID, ConfigInput{
		Name: detail.Name, Language: detail.Language, Source: detail.Source,
		Bindings: []Binding{{CollectionID: collection.ID, Operation: OperationCreate, Phase: PhaseAfterCommit}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Enable(ctx, detail.ID); err != nil {
		t.Fatal(err)
	}
	event := recordevents.Event{ID: "evt_pending_pin_test", CollectionID: collection.ID, RecordID: "rec_pending_pin_test", Type: recordevents.Created, SchemaVersion: 1}
	if err := fixture.store.WithTransaction(ctx, func(tx storage.Executor) error {
		return fixture.service.AppendIntent(ctx, tx, event)
	}); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := tx.ExecContext(ctx, `UPDATE modelry_extension_intents SET origin_grants_json='{' WHERE event_id=?`, event.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	fixture.service.AfterCommit(ctx, event)

	page, err := fixture.service.ListRuns(ctx, detail.ID, RunListOptions{Limit: 10})
	if err != nil || len(page.Data) != 1 || page.Data[0].Status != RunFailed || page.Data[0].ErrorCode != "invalidOutput" {
		t.Fatalf("malformed pinned Hook Run = %+v, %v", page.Data, err)
	}
	var intentStatus string
	if err := fixture.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT status FROM modelry_extension_intents WHERE event_id=?`, event.ID).Scan(&intentStatus)
	}); err != nil || intentStatus != "failed" {
		t.Fatalf("malformed pinned Intent status = %q, error=%v", intentStatus, err)
	}
}

func TestRejectedBeforeHookLeavesNoRecordOrEvent(t *testing.T) {
	ctx := context.Background()
	fixture := newExtensionFixture(t, invocationFunc(func(_ context.Context, invocation Invocation) (json.RawMessage, error) {
		return json.RawMessage(`{"action":"reject"}`), nil
	}))
	collection, err := fixture.models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Blocked", Type: backendmodel.CollectionTypeNormal, Fields: []backendmodel.Field{{Name: "title", Type: backendmodel.FieldTypeText, Required: true}}})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := fixture.service.Create(ctx, ConfigInput{Name: "Reject writes", Language: LanguageJavaScript, Source: `export function beforeCreate() { return { action: "reject" }; }`})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Replace(ctx, detail.ID, ConfigInput{Name: detail.Name, Language: detail.Language, Source: detail.Source, Bindings: []Binding{{CollectionID: collection.ID, Operation: OperationCreate, Phase: PhaseBefore}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Enable(ctx, detail.ID); err != nil {
		t.Fatal(err)
	}
	recordService, err := records.New(fixture.store, fixture.models, records.WithRecordEvents(fixture.events), records.WithLifecycleHooks(fixture.service))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recordService.Create(ctx, collection.ID, map[string]any{"title": "blocked"}); !errors.Is(err, recordlifecycle.ErrRejected) {
		t.Fatalf("Record create error = %v, want rejection", err)
	}
	page, err := recordService.List(ctx, collection.ID, records.ListOptions{Limit: 10})
	if err != nil || len(page.Data) != 0 {
		t.Fatalf("rejected write persisted Record: page=%+v err=%v", page, err)
	}
	position, err := fixture.events.State(ctx, collection.ID)
	if err != nil || position.Head != 0 {
		t.Fatalf("rejected write appended Record Event: position=%+v err=%v", position, err)
	}
	runs, err := fixture.service.ListRuns(ctx, detail.ID, RunListOptions{Limit: 10})
	if err != nil || len(runs.Data) != 1 || runs.Data[0].Status != RunRejected {
		t.Fatalf("rejected Hook Run history = %+v, %v", runs, err)
	}
}
