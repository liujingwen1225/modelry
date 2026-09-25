package extensions

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/extensions/safehttp"
	"github.com/liujingwen1225/modelry/internal/recordevents"
	"github.com/liujingwen1225/modelry/internal/recordlifecycle"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const maximumHookJSONBytes = 1 << 20

type activeBinding struct {
	ID        string
	Extension string
	Revision  int64
	Function  string
	Compiled  string
}

func (service *Service) Before(ctx context.Context, change recordlifecycle.BeforeChange) (map[string]any, error) {
	operation := Operation(change.Operation)
	binding, err := service.beforeBinding(ctx, change.CollectionID, operation)
	if errors.Is(err, ErrNotFound) {
		return change.Values, nil
	}
	if err != nil {
		return nil, recordlifecycle.ErrRuntimeUnavailable
	}
	if binding == nil {
		return change.Values, nil
	}
	phase := hookFunction(operation, PhaseBefore)
	input := map[string]any{
		"apiVersion":   "modelry.extension/v1",
		"phase":        phase,
		"operation":    string(operation),
		"collectionId": change.CollectionID,
		"modelVersion": change.ModelVersion,
		"values":       change.Values,
	}
	if change.Previous != nil {
		input["previous"] = change.Previous
	}
	encoded, err := json.Marshal(input)
	if err != nil || len(encoded) > maximumHookJSONBytes {
		service.insertTerminalBeforeRun(ctx, *binding, change, RunFailed, "invalidOutput", 0)
		return nil, recordlifecycle.ErrInvalidOutput
	}
	started := time.Now()
	runID, err := service.startBeforeRun(ctx, *binding, change)
	if err != nil {
		return nil, recordlifecycle.ErrRuntimeUnavailable
	}
	select {
	case service.semaphore <- struct{}{}:
	default:
		_ = service.finishBeforeRun(ctx, runID, RunFailed, "capacityExceeded", 0)
		return nil, recordlifecycle.ErrRuntimeUnavailable
	}
	callCtx, cancel := service.invocationContext(ctx, 2*time.Second)
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		cancel()
		<-service.semaphore
		_ = service.finishBeforeRun(ctx, runID, RunCancelled, "invocationCancelled", 0)
		return nil, recordlifecycle.ErrRuntimeUnavailable
	}
	service.cancels[runID] = activeRun{cancel: cancel, extensionID: binding.Extension, bindingID: binding.ID}
	service.wg.Add(1)
	service.mu.Unlock()
	defer func() {
		cancel()
		<-service.semaphore
		service.mu.Lock()
		delete(service.cancels, runID)
		service.mu.Unlock()
		service.wg.Done()
	}()
	if !service.bindingStillEnabled(callCtx, *binding) {
		_ = service.finishBeforeRun(ctx, runID, RunCancelled, "bindingOrGrantRevoked", 0)
		return nil, recordlifecycle.ErrRuntimeUnavailable
	}
	if service.invoker == nil {
		service.finishBeforeRun(ctx, runID, RunFailed, "extensionRuntimeUnavailable", time.Since(started))
		return nil, recordlifecycle.ErrRuntimeUnavailable
	}
	output, callErr := service.invoker.Invoke(callCtx, Invocation{Code: binding.Compiled, Phase: phase, Context: encoded})
	if callErr != nil {
		status, code, lifeErr := mapBeforeFailure(callErr)
		if err := service.finishBeforeRun(ctx, runID, status, code, time.Since(started)); err != nil {
			return nil, recordlifecycle.ErrRuntimeUnavailable
		}
		return nil, lifeErr
	}
	values, rejected, outputErr := decodeBeforeResult(output, operation, change.Values)
	if outputErr != nil {
		if err := service.finishBeforeRun(ctx, runID, RunFailed, "invalidOutput", time.Since(started)); err != nil {
			return nil, recordlifecycle.ErrRuntimeUnavailable
		}
		return nil, recordlifecycle.ErrInvalidOutput
	}
	if rejected {
		if err := service.finishBeforeRun(ctx, runID, RunRejected, "changeRejected", time.Since(started)); err != nil {
			return nil, recordlifecycle.ErrRuntimeUnavailable
		}
		return nil, recordlifecycle.ErrRejected
	}
	if err := service.finishBeforeRun(ctx, runID, RunSucceeded, "", time.Since(started)); err != nil {
		return nil, recordlifecycle.ErrRuntimeUnavailable
	}
	return values, nil
}

func (service *Service) beforeBinding(ctx context.Context, collectionID string, operation Operation) (*activeBinding, error) {
	var binding *activeBinding
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		var item activeBinding
		err := snapshot.QueryRowContext(ctx, `SELECT b.id,e.id,e.active_revision,r.compiled_source FROM modelry_extension_bindings b JOIN modelry_extensions e ON e.id=b.extension_id JOIN modelry_extension_revisions r ON r.extension_id=e.id AND r.revision=e.active_revision WHERE e.enabled=1 AND b.collection_id=? AND b.operation=? AND b.phase='before'`, collectionID, operation).Scan(&item.ID, &item.Extension, &item.Revision, &item.Compiled)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		binding = &item
		return nil
	})
	return binding, err
}

func (service *Service) bindingStillEnabled(ctx context.Context, binding activeBinding) bool {
	var exists int
	err := service.store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT 1 FROM modelry_extensions e JOIN modelry_extension_bindings b ON b.extension_id=e.id WHERE e.id=? AND e.enabled=1 AND b.id=?`, binding.Extension, binding.ID).Scan(&exists)
	})
	return err == nil && exists == 1
}

func (service *Service) AppendIntent(ctx context.Context, tx storage.Executor, event recordevents.Event) error {
	if event.ID == "" || event.RecordID == "" || event.SchemaVersion < 1 {
		return nil
	}
	operation := operationFromEvent(event.Type)
	if operation == "" {
		return nil
	}
	var extensionID, bindingID string
	var revision int64
	err := tx.QueryRowContext(ctx, `SELECT e.id,b.id,e.active_revision FROM modelry_extension_bindings b JOIN modelry_extensions e ON e.id=b.extension_id WHERE e.enabled=1 AND b.collection_id=? AND b.operation=? AND b.phase='afterCommit'`, event.CollectionID, operation).Scan(&extensionID, &bindingID, &revision)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	secrets := make([]SecretBindingInput, 0)
	rows, err := tx.QueryContext(ctx, `SELECT alias,secret_id FROM modelry_extension_secret_bindings WHERE extension_id=? ORDER BY alias`, extensionID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var item SecretBindingInput
		if err := rows.Scan(&item.Alias, &item.SecretID); err != nil {
			rows.Close()
			return err
		}
		secrets = append(secrets, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	grants := make([]string, 0)
	rows, err = tx.QueryContext(ctx, `SELECT id FROM modelry_extension_origin_grants WHERE extension_id=? ORDER BY id`, extensionID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		grants = append(grants, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	secretJSON, err := json.Marshal(secrets)
	if err != nil {
		return err
	}
	grantJSON, err := json.Marshal(grants)
	if err != nil {
		return err
	}
	intentID, err := newID("int_")
	if err != nil {
		return err
	}
	runID, err := newID("run_")
	if err != nil {
		return err
	}
	correlation, err := newID("cor_")
	if err != nil {
		return err
	}
	now := service.timestamp()
	if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_extension_intents(id,extension_id,revision,binding_id,collection_id,record_id,event_id,operation,schema_version,secret_bindings_json,origin_grants_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`, intentID, extensionID, revision, bindingID, event.CollectionID, event.RecordID, event.ID, operation, event.SchemaVersion, string(secretJSON), string(grantJSON), now, now); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO modelry_extension_runs(id,intent_id,extension_id,revision,binding_id,collection_id,record_id,event_id,operation,phase,status,started_at,duration_ms,error_code,correlation_id) VALUES(?,?,?,?,?,?,?,?,?,'afterCommit','pending',?,0,'none',?)`, runID, intentID, extensionID, revision, bindingID, event.CollectionID, event.RecordID, event.ID, operation, now, correlation)
	if err != nil {
		return err
	}
	return pruneRuns(ctx, tx)
}

func (service *Service) AfterCommit(_ context.Context, event recordevents.Event) {
	if service == nil || event.ID == "" {
		return
	}
	var intentID, extensionID, bindingID, secretsJSON, grantsJSON string
	err := service.store.WithReadSnapshot(service.ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(service.ctx, `SELECT id,extension_id,binding_id,secret_bindings_json,origin_grants_json FROM modelry_extension_intents WHERE event_id=? AND status='pending'`, event.ID).Scan(&intentID, &extensionID, &bindingID, &secretsJSON, &grantsJSON)
	})
	if err != nil {
		service.failPendingEvent(event.ID, "extensionRuntimeUnavailable")
		return
	}
	var secretPins []SecretBindingInput
	var grantPins []string
	if json.Unmarshal([]byte(secretsJSON), &secretPins) != nil || json.Unmarshal([]byte(grantsJSON), &grantPins) != nil || secretPins == nil || grantPins == nil {
		service.failPendingEvent(event.ID, "invalidOutput")
		return
	}
	secretIDs := make([]string, 0, len(secretPins))
	for _, pin := range secretPins {
		secretIDs = append(secretIDs, pin.SecretID)
	}
	select {
	case service.semaphore <- struct{}{}:
	default:
		service.failPendingIntent(intentID, "capacityExceeded")
		return
	}
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		<-service.semaphore
		return
	}
	callCtx, cancel := context.WithCancel(service.ctx)
	service.cancels[intentID] = activeRun{cancel: cancel, extensionID: extensionID, bindingID: bindingID, secretBindings: secretPins, secretIDs: secretIDs, grantIDs: grantPins}
	service.wg.Add(1)
	service.mu.Unlock()
	go func() {
		defer service.wg.Done()
		defer func() {
			cancel()
			<-service.semaphore
			service.mu.Lock()
			delete(service.cancels, intentID)
			service.mu.Unlock()
		}()
		service.runAfter(callCtx, intentID, event)
	}()
}

type pinnedExecution struct {
	compiled                                                string
	extensionID, bindingID, collectionID, recordID, eventID string
	revision                                                int64
	operation                                               Operation
	schemaVersion                                           int
	secrets                                                 []SecretBindingInput
	grants                                                  []string
	secretCipher                                            map[string]encryptedSecret
	origins                                                 []string
}
type encryptedSecret struct {
	id      string
	version int64
	value   []byte
}

func (service *Service) runAfter(ctx context.Context, intentID string, event recordevents.Event) {
	started := time.Now()
	var pinned pinnedExecution
	if err := service.startAfter(ctx, intentID, &pinned); err != nil {
		if !errors.Is(err, ErrConflict) && !errors.Is(err, context.Canceled) {
			service.failPendingIntent(intentID, "extensionRuntimeUnavailable")
		}
		return
	}
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	loaded, err := service.loadPinnedSecrets(pinned)
	if err != nil {
		code := "secretNotAvailable"
		if errors.Is(err, ErrSecretKeyUnavailable) {
			code = "secretKeyUnavailable"
		}
		service.finishAfter(intentID, RunFailed, code, time.Since(started))
		return
	}
	defer func() {
		for _, secret := range loaded {
			clear(secret)
		}
	}()
	phase := hookFunction(pinned.operation, PhaseAfterCommit)
	contextValue, err := afterContext(event, phase, pinned.operation)
	if err != nil {
		service.finishAfter(intentID, RunFailed, "invalidOutput", time.Since(started))
		return
	}
	encoded, err := json.Marshal(contextValue)
	if err != nil || len(encoded) > maximumHookJSONBytes {
		service.finishAfter(intentID, RunFailed, "invalidOutput", time.Since(started))
		return
	}
	var callbackErr error
	secretLookup := func(_ context.Context, alias string) (string, error) {
		pin := findSecretPin(pinned.secrets, alias)
		if pin == nil {
			callbackErr = ErrSecretNotAvailable
			return "", ErrSecretNotAvailable
		}
		value, ok := loaded[alias]
		if !ok {
			callbackErr = ErrSecretNotAvailable
			return "", ErrSecretNotAvailable
		}
		return string(value), nil
	}
	httpRequest := HTTPRequest(nil)
	if len(pinned.origins) > 0 {
		if service.httpRequest != nil {
			httpRequest = func(ctx context.Context, request json.RawMessage) (json.RawMessage, error) {
				response, err := service.httpRequest(ctx, request)
				if err != nil {
					callbackErr = err
				}
				return response, err
			}
		} else if client, clientErr := safehttp.New(pinned.origins); clientErr == nil {
			httpRequest = func(ctx context.Context, request json.RawMessage) (json.RawMessage, error) {
				response, err := executeSafeHTTPRequest(ctx, client, request)
				if err != nil {
					callbackErr = err
				}
				return response, err
			}
		}
	}
	if service.invoker == nil {
		service.finishAfter(intentID, RunFailed, "extensionRuntimeUnavailable", time.Since(started))
		return
	}
	output, invokeErr := service.invoker.Invoke(callCtx, Invocation{Code: pinned.compiled, Phase: phase, Context: encoded, SecretLookup: secretLookup, HTTPRequest: httpRequest})
	if invokeErr != nil {
		if callbackErr != nil {
			invokeErr = callbackErr
		}
		code := mapAfterFailure(invokeErr)
		status := RunFailed
		if code == "invocationCancelled" {
			status = RunCancelled
		}
		service.finishAfter(intentID, status, code, time.Since(started))
		return
	}
	if len(bytes.TrimSpace(output)) > 0 && !bytes.Equal(bytes.TrimSpace(output), []byte("null")) {
		service.finishAfter(intentID, RunFailed, "invalidOutput", time.Since(started))
		return
	}
	service.finishAfter(intentID, RunSucceeded, "", time.Since(started))
}

func (service *Service) startAfter(ctx context.Context, intentID string, pinned *pinnedExecution) error {
	return service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var secretsJSON, grantsJSON string
		var status string
		var enabled int
		if err := tx.QueryRowContext(ctx, `SELECT i.extension_id,i.revision,i.binding_id,i.collection_id,i.record_id,i.event_id,i.operation,i.schema_version,i.secret_bindings_json,i.origin_grants_json,i.status,e.enabled,r.compiled_source FROM modelry_extension_intents i JOIN modelry_extensions e ON e.id=i.extension_id JOIN modelry_extension_revisions r ON r.extension_id=i.extension_id AND r.revision=i.revision WHERE i.id=?`, intentID).Scan(&pinned.extensionID, &pinned.revision, &pinned.bindingID, &pinned.collectionID, &pinned.recordID, &pinned.eventID, &pinned.operation, &pinned.schemaVersion, &secretsJSON, &grantsJSON, &status, &enabled, &pinned.compiled); err != nil {
			return err
		}
		if status != "pending" || enabled != 1 {
			return ErrConflict
		}
		var bindingExists int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM modelry_extension_bindings WHERE id=? AND extension_id=?`, pinned.bindingID, pinned.extensionID).Scan(&bindingExists); err != nil {
			return ErrConflict
		}
		if err := json.Unmarshal([]byte(secretsJSON), &pinned.secrets); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(grantsJSON), &pinned.grants); err != nil {
			return err
		}
		pinned.secretCipher = make(map[string]encryptedSecret, len(pinned.secrets))
		for _, secret := range pinned.secrets {
			var item encryptedSecret
			item.id = secret.SecretID
			if err := tx.QueryRowContext(ctx, `SELECT version,value_cipher FROM modelry_secrets WHERE id=?`, secret.SecretID).Scan(&item.version, &item.value); err != nil {
				return ErrSecretNotAvailable
			}
			pinned.secretCipher[secret.Alias] = item
		}
		pinned.origins = make([]string, 0, len(pinned.grants))
		for _, grantID := range pinned.grants {
			var origin string
			if err := tx.QueryRowContext(ctx, `SELECT origin FROM modelry_extension_origin_grants WHERE id=? AND extension_id=?`, grantID, pinned.extensionID).Scan(&origin); err != nil {
				return ErrConflict
			}
			pinned.origins = append(pinned.origins, origin)
		}
		now := service.timestamp()
		result, err := tx.ExecContext(ctx, `UPDATE modelry_extension_intents SET status='running',updated_at=? WHERE id=? AND status='pending'`, now, intentID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil || count != 1 {
			return ErrConflict
		}
		_, err = tx.ExecContext(ctx, `UPDATE modelry_extension_runs SET status='running',started_at=?,error_code='none' WHERE intent_id=? AND status='pending'`, now, intentID)
		return err
	})
}

func (service *Service) loadPinnedSecrets(pinned pinnedExecution) (map[string][]byte, error) {
	loaded := make(map[string][]byte, len(pinned.secretCipher))
	for alias, item := range pinned.secretCipher {
		plain, err := service.secrets.Decrypt(item.id, item.version, item.value)
		clear(item.value)
		if err != nil {
			for _, value := range loaded {
				clear(value)
			}
			return nil, ErrSecretKeyUnavailable
		}
		loaded[alias] = plain
	}
	return loaded, nil
}

func (service *Service) finishAfter(intentID string, status RunStatus, code string, duration time.Duration) {
	ctx, cancel := context.WithTimeout(service.ctx, time.Second)
	defer cancel()
	now := service.timestamp()
	_ = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_extension_intents SET status=?,updated_at=? WHERE id=? AND status='running'`, status, now, intentID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE modelry_extension_runs SET status=?,completed_at=?,duration_ms=?,error_code=? WHERE intent_id=? AND status='running'`, status, now, duration.Milliseconds(), safeErrorCode(code), intentID)
		return err
	})
}

func (service *Service) failPendingIntent(intentID, code string) {
	ctx, cancel := context.WithTimeout(service.ctx, time.Second)
	defer cancel()
	_ = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		now := service.timestamp()
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_extension_intents SET status='failed',updated_at=? WHERE id=? AND status='pending'`, now, intentID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE modelry_extension_runs SET status='failed',completed_at=?,error_code=? WHERE intent_id=? AND status='pending'`, now, safeErrorCode(code), intentID)
		return err
	})
}

func (service *Service) failPendingEvent(eventID, code string) {
	ctx, cancel := context.WithTimeout(service.ctx, time.Second)
	defer cancel()
	_ = service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		now := service.timestamp()
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_extension_intents SET status='failed',updated_at=? WHERE event_id=? AND status='pending'`, now, eventID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE modelry_extension_runs SET status='failed',completed_at=?,error_code=? WHERE event_id=? AND phase='afterCommit' AND status='pending'`, now, safeErrorCode(code), eventID)
		return err
	})
}

func (service *Service) interruptPending(ctx context.Context, tx storage.Executor) error {
	rows, err := tx.QueryContext(ctx, `SELECT id,intent_id FROM modelry_extension_runs WHERE status IN ('pending','running')`)
	if err != nil {
		return err
	}
	type item struct{ run, intent string }
	items := []item{}
	for rows.Next() {
		var value item
		if err := rows.Scan(&value.run, &value.intent); err != nil {
			rows.Close()
			return err
		}
		items = append(items, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	now := service.timestamp()
	for _, value := range items {
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_extension_runs SET status='interrupted',completed_at=?,error_code='runtimeRestarted' WHERE id=? AND status IN ('pending','running')`, now, value.run); err != nil {
			return err
		}
		if value.intent != "" {
			if _, err := tx.ExecContext(ctx, `UPDATE modelry_extension_intents SET status='interrupted',updated_at=? WHERE id=? AND status IN ('pending','running')`, now, value.intent); err != nil {
				return err
			}
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE modelry_extension_intents SET status='interrupted',updated_at=? WHERE status IN ('pending','running')`, now)
	return err
}

func (service *Service) startBeforeRun(ctx context.Context, binding activeBinding, change recordlifecycle.BeforeChange) (string, error) {
	runID, err := newID("run_")
	if err != nil {
		return "", err
	}
	correlation, err := newID("cor_")
	if err != nil {
		return "", err
	}
	now := service.timestamp()
	_, err = service.storeExec(ctx, `INSERT INTO modelry_extension_runs(id,extension_id,revision,binding_id,collection_id,record_id,event_id,operation,phase,status,started_at,duration_ms,error_code,correlation_id) VALUES(?,?,?,?,?,?,? ,?,'before','running',?,0,'none',?)`, runID, binding.Extension, binding.Revision, binding.ID, change.CollectionID, change.RecordID, "", change.Operation, now, correlation)
	return runID, err
}

func (service *Service) insertTerminalBeforeRun(ctx context.Context, binding activeBinding, change recordlifecycle.BeforeChange, status RunStatus, code string, duration time.Duration) {
	runID, err := newID("run_")
	if err != nil {
		return
	}
	correlation, err := newID("cor_")
	if err != nil {
		return
	}
	now := service.timestamp()
	_, _ = service.storeExec(ctx, `INSERT INTO modelry_extension_runs(id,extension_id,revision,binding_id,collection_id,record_id,event_id,operation,phase,status,started_at,completed_at,duration_ms,error_code,correlation_id) VALUES(?,?,?,?,?,?,? ,?,'before',?,?,?,?,?,?)`, runID, binding.Extension, binding.Revision, binding.ID, change.CollectionID, change.RecordID, "", change.Operation, status, now, now, duration.Milliseconds(), safeErrorCode(code), correlation)
}

func (service *Service) finishBeforeRun(ctx context.Context, runID string, status RunStatus, code string, duration time.Duration) error {
	persistCtx, cancel := context.WithTimeout(service.ctx, time.Second)
	defer cancel()
	now := service.timestamp()
	_, err := service.storeExec(persistCtx, `UPDATE modelry_extension_runs SET status=?,completed_at=?,duration_ms=?,error_code=? WHERE id=? AND status='running'`, status, now, duration.Milliseconds(), safeErrorCode(code), runID)
	return err
}

func (service *Service) storeExec(ctx context.Context, query string, args ...any) (sql.Result, error) {
	var result sql.Result
	err := service.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var err error
		result, err = tx.ExecContext(ctx, query, args...)
		if err != nil {
			return err
		}
		return pruneRuns(ctx, tx)
	})
	return result, err
}

func pruneRuns(ctx context.Context, tx storage.Executor) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM modelry_extension_runs WHERE id IN (
		SELECT id FROM modelry_extension_runs ORDER BY started_at DESC,id DESC LIMIT -1 OFFSET 5000
	)`)
	return err
}

func (service *Service) invocationContext(ctx context.Context, limit time.Duration) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	callCtx, cancel := context.WithTimeout(ctx, limit)
	stop := context.AfterFunc(service.ctx, cancel)
	return callCtx, func() { stop(); cancel() }
}

func hookFunction(operation Operation, phase Phase) string {
	prefix := "before"
	if phase == PhaseAfterCommit {
		prefix = "afterCommit"
	}
	suffix := strings.ToUpper(string(operation[:1])) + string(operation[1:])
	return prefix + suffix
}
func operationFromEvent(eventType recordevents.Type) Operation {
	switch eventType {
	case recordevents.Created:
		return OperationCreate
	case recordevents.Updated:
		return OperationUpdate
	case recordevents.Deleted:
		return OperationDelete
	default:
		return ""
	}
}
func safeErrorCode(code string) string {
	switch code {
	case "capacityExceeded", "runtimeRestarted", "extensionDisabled", "bindingOrGrantRevoked", "secretRevoked", "invocationCancelled", "extensionRuntimeUnavailable", "budgetExceeded", "invalidOutput", "changeRejected", "secretNotAvailable", "secretKeyUnavailable", "externalRequestFailed", "originNotAllowed", "hookFailed":
		return code
	default:
		if code == "" {
			return "none"
		}
		return "hookFailed"
	}
}

type beforeResult struct {
	Action string         `json:"action"`
	Values map[string]any `json:"values,omitempty"`
}

func decodeBeforeResult(output json.RawMessage, operation Operation, original map[string]any) (map[string]any, bool, error) {
	if len(output) == 0 || len(output) > maximumHookJSONBytes {
		return nil, false, recordlifecycle.ErrInvalidOutput
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(output, &raw); err != nil || raw == nil {
		return nil, false, recordlifecycle.ErrInvalidOutput
	}
	for key := range raw {
		if key != "action" && key != "values" {
			return nil, false, recordlifecycle.ErrInvalidOutput
		}
	}
	var result beforeResult
	if err := json.Unmarshal(output, &result); err != nil {
		return nil, false, recordlifecycle.ErrInvalidOutput
	}
	switch result.Action {
	case "reject":
		if _, has := raw["values"]; has {
			return nil, false, recordlifecycle.ErrInvalidOutput
		}
		return nil, true, nil
	case "allow":
	default:
		return nil, false, recordlifecycle.ErrInvalidOutput
	}
	if operation == OperationDelete {
		if _, has := raw["values"]; has {
			return nil, false, recordlifecycle.ErrInvalidOutput
		}
		return original, false, nil
	}
	if value, has := raw["values"]; has {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || result.Values == nil {
			return nil, false, recordlifecycle.ErrInvalidOutput
		}
		return result.Values, false, nil
	}
	return original, false, nil
}

func mapBeforeFailure(err error) (RunStatus, string, error) {
	switch {
	case errors.Is(err, ErrBudgetExceeded), errors.Is(err, recordlifecycle.ErrBudgetExceeded):
		return RunFailed, "budgetExceeded", recordlifecycle.ErrBudgetExceeded
	case errors.Is(err, ErrInvocationCancelled), errors.Is(err, context.Canceled):
		return RunCancelled, "invocationCancelled", recordlifecycle.ErrRuntimeUnavailable
	case errors.Is(err, recordlifecycle.ErrRejected):
		return RunRejected, "changeRejected", recordlifecycle.ErrRejected
	case errors.Is(err, ErrInvalidOutput), errors.Is(err, ErrAsyncResult), errors.Is(err, ErrInvalidInvocation), errors.Is(err, recordlifecycle.ErrInvalidOutput):
		return RunFailed, "invalidOutput", recordlifecycle.ErrInvalidOutput
	case errors.Is(err, context.DeadlineExceeded):
		return RunFailed, "budgetExceeded", recordlifecycle.ErrBudgetExceeded
	default:
		return RunFailed, "extensionRuntimeUnavailable", recordlifecycle.ErrRuntimeUnavailable
	}
}

func mapAfterFailure(err error) string {
	switch {
	case errors.Is(err, ErrBudgetExceeded):
		return "budgetExceeded"
	case errors.Is(err, ErrSecretUnavailable), errors.Is(err, ErrSecretNotAvailable):
		return "secretNotAvailable"
	case errors.Is(err, ErrSecretKeyUnavailable):
		return "secretKeyUnavailable"
	case errors.Is(err, ErrExternalRequestFailed):
		return "externalRequestFailed"
	case errors.Is(err, safehttp.ErrOriginNotAllowed):
		return "originNotAllowed"
	case errors.Is(err, ErrInvalidOutput), errors.Is(err, ErrAsyncResult), errors.Is(err, ErrInvalidInvocation):
		return "invalidOutput"
	case errors.Is(err, ErrInvocationCancelled), errors.Is(err, context.Canceled):
		return "invocationCancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return "budgetExceeded"
	default:
		return "hookFailed"
	}
}

type safeHTTPRequestInput struct {
	Origin  string            `json:"origin"`
	Path    string            `json:"path"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

func executeSafeHTTPRequest(ctx context.Context, client *safehttp.Client, raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || len(raw) > maximumHookInputBytes || !json.Valid(raw) {
		return nil, ErrExternalRequestFailed
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, ErrExternalRequestFailed
	}
	for key := range fields {
		if key != "origin" && key != "path" && key != "method" && key != "headers" && key != "body" {
			return nil, ErrExternalRequestFailed
		}
	}
	for _, key := range []string{"origin", "path", "method"} {
		if _, exists := fields[key]; !exists {
			return nil, ErrExternalRequestFailed
		}
	}
	var input safeHTTPRequestInput
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return nil, ErrExternalRequestFailed
	}
	response, err := client.Request(ctx, safehttp.Request{Origin: input.Origin, Path: input.Path, Method: input.Method, Headers: input.Headers, Body: input.Body})
	if err != nil {
		if errors.Is(err, safehttp.ErrOriginNotAllowed) {
			return nil, safehttp.ErrOriginNotAllowed
		}
		return nil, ErrExternalRequestFailed
	}
	encoded, err := json.Marshal(map[string]any{"status": response.Status, "headers": response.Headers, "body": response.Body})
	if err != nil {
		return nil, ErrExternalRequestFailed
	}
	return encoded, nil
}

func afterContext(event recordevents.Event, phase string, operation Operation) (map[string]any, error) {
	contextValue := map[string]any{"apiVersion": "modelry.extension/v1", "phase": phase, "operation": string(operation), "eventId": event.ID, "collectionId": event.CollectionID, "modelVersion": event.SchemaVersion}
	if operation == OperationDelete {
		identity := map[string]any{"id": event.RecordID}
		if event.Before != nil {
			for _, key := range []string{"createdAt", "updatedAt"} {
				if value, ok := event.Before[key]; ok {
					identity[key] = value
				}
			}
		}
		contextValue["record"] = identity
		return contextValue, nil
	}
	if event.After == nil {
		return nil, fmt.Errorf("committed Event snapshot is missing")
	}
	contextValue["record"] = event.After
	return contextValue, nil
}

func (service *Service) cancelIntentInTransaction(ctx context.Context, tx storage.Executor, intentID, code string) error {
	now := service.timestamp()
	if _, err := tx.ExecContext(ctx, `UPDATE modelry_extension_intents SET status='cancelled',updated_at=? WHERE id=? AND status='pending'`, now, intentID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE modelry_extension_runs SET status='cancelled',completed_at=?,error_code=? WHERE intent_id=? AND status='pending'`, now, safeErrorCode(code), intentID)
	return err
}

func parseTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}
func findSecretPin(pins []SecretBindingInput, alias string) *SecretBindingInput {
	for i := range pins {
		if pins[i].Alias == alias {
			return &pins[i]
		}
	}
	return nil
}
