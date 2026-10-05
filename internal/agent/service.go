package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/liujingwen1225/modelry/internal/agenttools"
	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/extensions"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/permissions"
	"github.com/liujingwen1225/modelry/internal/serviceaccounts"
	"github.com/liujingwen1225/modelry/internal/storage"
)

var ErrForbidden = errors.New("此智能体未获操作授权")
var ErrConflict = errors.New("状态已变化，请重新检查并提出操作")
var ErrInvalid = errors.New("参数无效")
var ErrNotFound = errors.New("会话或操作不存在")

type Store interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}
type Actor struct {
	Identity string `json:"identity"`
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	KeyID    string `json:"-"`
}
type Policy struct {
	Mode              string   `json:"mode"`
	AllowedOperations []string `json:"allowedOperations"`
	AutoOperations    []string `json:"autoOperations"`
	Revision          int      `json:"revision"`
}
type Operation struct {
	ID             string         `json:"id"`
	SessionID      string         `json:"sessionId"`
	Name           string         `json:"name"`
	Title          string         `json:"title"`
	Arguments      map[string]any `json:"arguments"`
	Actor          Actor          `json:"actor"`
	State          string         `json:"state"`
	Risk           bool           `json:"risk"`
	Before         any            `json:"before,omitempty"`
	Result         any            `json:"result,omitempty"`
	Error          string         `json:"error,omitempty"`
	ApproverID     string         `json:"approverId,omitempty"`
	CreatedAt      string         `json:"createdAt"`
	RequestID      string         `json:"requestId"`
	Fingerprint    string         `json:"-"`
	PolicyRevision int            `json:"policyRevision"`
	CredentialID   string         `json:"-"`
}
type DataGrant struct {
	CollectionID string   `json:"collectionId"`
	Fields       []string `json:"fields"`
}
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type Session struct {
	ID           string      `json:"id"`
	Title        string      `json:"title"`
	Actor        Actor       `json:"actor"`
	State        string      `json:"state"`
	Messages     []Message   `json:"messages"`
	Operations   []Operation `json:"operations"`
	DataGrants   []DataGrant `json:"dataGrants"`
	Sequence     int         `json:"sequence"`
	UpdatedAt    string      `json:"updatedAt"`
	PageContext  string      `json:"pageContext,omitempty"`
	CredentialID string      `json:"-"`
}
type Resolver func(context.Context, Actor) (context.Context, error)
type Service struct {
	store         Store
	secrets       *extensions.Service
	audits        *audit.Service
	resolve       Resolver
	handler       http.Handler
	mu            sync.Mutex
	executeMu     sync.Mutex
	mutationGuard *MutationGate
	configMu      sync.Mutex
	runs          map[string]context.CancelFunc
	wg            sync.WaitGroup
	closed        bool
	done          chan struct{}
}

func NewService(ctx context.Context, store Store, secrets *extensions.Service, audits *audit.Service, resolve Resolver) (*Service, error) {
	s := &Service{store: store, secrets: secrets, audits: audits, resolve: resolve, runs: map[string]context.CancelFunc{}, done: make(chan struct{})}
	err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		for _, sql := range []string{
			`CREATE TABLE IF NOT EXISTS modelry_agent_documents(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL, PRIMARY KEY(kind,id))`,
			`CREATE TABLE IF NOT EXISTS modelry_agent_operations(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,fingerprint TEXT NOT NULL,credential_id TEXT NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS modelry_agent_credentials(session_id TEXT PRIMARY KEY,key_id TEXT NOT NULL)`,
			`UPDATE modelry_agent_operations SET state='interrupted' WHERE state='executing'`,
		} {
			if _, err := tx.ExecContext(ctx, sql); err != nil {
				return err
			}
		}
		rows, err := tx.QueryContext(ctx, `SELECT id,body FROM modelry_agent_documents WHERE kind='session'`)
		if err != nil {
			return err
		}
		var interrupted []Session
		for rows.Next() {
			var id, body string
			if err := rows.Scan(&id, &body); err != nil {
				rows.Close()
				return err
			}
			var v Session
			if err := json.Unmarshal([]byte(body), &v); err != nil {
				rows.Close()
				return err
			}
			if v.State == "running" || v.State == "awaitingApproval" {
				v.State = "interrupted"
				v.Sequence++
				interrupted = append(interrupted, v)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		for _, v := range interrupted {
			if err := putDocument(ctx, tx, "session", v.ID, v); err != nil {
				return err
			}
		}
		return nil
	})
	return s, err
}
func (s *Service) SetHandler(h http.Handler) { s.handler = h }

// SetMutationGuard 让目标复核与正式写入共享运行时的写入门，防止人工 API 在两者之间改变目标。
func (s *Service) SetMutationGuard(guard *MutationGate) { s.mutationGuard = guard }

type mutationGuardHeld struct{}

func (s *Service) lockMutation(ctx context.Context) (func(), error) {
	if s.mutationGuard == nil || ctx.Value(mutationGuardHeld{}) == true {
		return func() {}, nil
	}
	if err := s.mutationGuard.Lock(ctx); err != nil {
		return nil, err
	}
	return s.mutationGuard.Unlock, nil
}

func (s *Service) Close() {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		close(s.done)
	}
	for _, cancel := range s.runs {
		cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
}
func newID(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(b[:])
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func putDocument(ctx context.Context, tx storage.Executor, kind, id string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO modelry_agent_documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body`, kind, id, string(b))
	return err
}
func readDocument(ctx context.Context, tx storage.Executor, kind, id string, v any) error {
	var b string
	if err := tx.QueryRowContext(ctx, `SELECT body FROM modelry_agent_documents WHERE kind=? AND id=?`, kind, id).Scan(&b); err != nil {
		return ErrNotFound
	}
	return json.Unmarshal([]byte(b), v)
}
func (s *Service) audit(ctx context.Context, tx storage.Executor, a Actor, action, id, result string) error {
	if result != "success" && result != "denied" {
		if result == "failed" || result == "stale" || result == "interrupted" {
			result = "failure"
		} else {
			result = "success"
		}
	}
	kind := "agentOperation"
	if strings.HasPrefix(id, "ags_") {
		kind = "agentSession"
	}
	return s.audits.AppendInTransaction(ctx, tx, audit.AppendInput{RequestID: httpapi.RequestID(ctx), Actor: audit.Actor{Kind: audit.ActorKind(a.Kind), ID: a.ID}, Action: action, Resource: audit.Resource{Kind: kind, ID: id}, Result: result})
}
func (s *Service) Policy(ctx context.Context, identity string) (Policy, error) {
	p := Policy{Mode: "confirmWrites", AllowedOperations: []string{}, AutoOperations: []string{}, Revision: 0}
	for _, op := range agenttools.Operations {
		if !slices.Contains(p.AllowedOperations, op.Permission) {
			p.AllowedOperations = append(p.AllowedOperations, op.Permission)
		}
	}
	err := s.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		err := readDocument(ctx, tx, "policy", identity, &p)
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	})
	return p, err
}
func (s *Service) SavePolicy(ctx context.Context, identity string, p Policy, a Actor) (Policy, error) {
	unlock, lockErr := s.lockMutation(ctx)
	if lockErr != nil {
		return Policy{}, lockErr
	}
	defer unlock()
	if a.Kind != "owner" {
		return p, ErrForbidden
	}
	if identity != "builtin" && !strings.HasPrefix(identity, "sa_") {
		return p, ErrInvalid
	}
	if p.Mode != "readOnly" && p.Mode != "confirmWrites" && p.Mode != "autoWrites" {
		return p, ErrInvalid
	}
	for _, op := range append(append([]string{}, p.AllowedOperations...), p.AutoOperations...) {
		if !permissions.KnownOperation(permissions.Operation(op)) {
			return p, ErrInvalid
		}
	}
	for _, op := range p.AutoOperations {
		if !slices.Contains(p.AllowedOperations, op) {
			return p, ErrInvalid
		}
	}
	err := s.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var old Policy
		err := readDocument(ctx, tx, "policy", identity, &old)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		if old.Revision != p.Revision {
			return ErrConflict
		}
		p.Revision++
		if err := putDocument(ctx, tx, "policy", identity, p); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, "agent.policyUpdated", identity, "success")
	})
	return p, err
}
func (s *Service) CreateSession(ctx context.Context, a Actor, title string) (Session, error) {
	v := Session{ID: newID("ags_"), Actor: a, State: "completed", Title: strings.TrimSpace(title), Messages: []Message{}, Operations: []Operation{}, DataGrants: []DataGrant{}, Sequence: 1, UpdatedAt: now()}
	if len(v.Title) > 200 {
		return v, ErrInvalid
	}
	if v.Title == "" {
		v.Title = "Agent"
	}
	err := s.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if err := putDocument(ctx, tx, "session", v.ID, v); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO modelry_agent_credentials(session_id,key_id) VALUES(?,?)`, v.ID, a.KeyID)
		return err
	})
	return v, err
}
func (s *Service) GetSession(ctx context.Context, id string, a Actor) (Session, error) {
	var v Session
	err := s.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		if err := readDocument(ctx, tx, "session", id, &v); err != nil {
			return err
		}
		if a.Kind != "owner" && (v.Actor.ID != a.ID || v.Actor.Kind != a.Kind) {
			return ErrForbidden
		}
		if err := tx.QueryRowContext(ctx, `SELECT key_id FROM modelry_agent_credentials WHERE session_id=?`, id).Scan(&v.CredentialID); err != nil {
			return err
		}
		return nil
	})
	if err == nil {
		for i, op := range v.Operations {
			current, readErr := s.GetOperation(ctx, op.ID, a)
			if readErr != nil {
				return v, readErr
			}
			v.Operations[i] = current
		}
	}
	return v, err
}
func (s *Service) Sessions(ctx context.Context, a Actor) ([]Session, error) {
	result := []Session{}
	err := s.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		rows, err := tx.QueryContext(ctx, `SELECT body FROM modelry_agent_documents WHERE kind='session' ORDER BY rowid DESC LIMIT 100`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var body string
			if err := rows.Scan(&body); err != nil {
				return err
			}
			var v Session
			if err := json.Unmarshal([]byte(body), &v); err != nil {
				return err
			}
			if a.Kind == "owner" || v.Actor.ID == a.ID && v.Actor.Kind == a.Kind {
				result = append(result, v)
			}
		}
		return rows.Err()
	})
	return result, err
}
func (s *Service) updateSession(ctx context.Context, id string, update func(*Session) error, auditEvents ...func(storage.Executor) error) error {
	return s.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var v Session
		if err := readDocument(ctx, tx, "session", id, &v); err != nil {
			return err
		}
		if err := update(&v); err != nil {
			return err
		}
		v.Sequence++
		v.UpdatedAt = now()
		if err := putDocument(ctx, tx, "session", id, v); err != nil {
			return err
		}
		for _, appendAudit := range auditEvents {
			if err := appendAudit(tx); err != nil {
				return err
			}
		}
		return nil
	})
}
func (s *Service) GetOperation(ctx context.Context, id string, a Actor) (Operation, error) {
	var op Operation
	err := s.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		var body string
		if err := tx.QueryRowContext(ctx, `SELECT body,state,fingerprint,credential_id FROM modelry_agent_operations WHERE id=?`, id).Scan(&body, &op.State, &op.Fingerprint, &op.CredentialID); err != nil {
			return ErrNotFound
		}
		state, fp, key := op.State, op.Fingerprint, op.CredentialID
		if err := json.Unmarshal([]byte(body), &op); err != nil {
			return err
		}
		op.State, op.Fingerprint, op.CredentialID = state, fp, key
		if a.Kind != "owner" && (op.Actor.ID != a.ID || op.Actor.Kind != a.Kind) {
			return ErrForbidden
		}
		return nil
	})
	// 仅在 Owner 的审核界面按当前固定快照显示旧值；不把业务读取结果写入会话或发送给模型。
	if err == nil && a.Kind == "owner" && op.State == "awaitingApproval" && strings.HasPrefix(op.Name, "records_") {
		actor := op.Actor
		actor.KeyID = op.CredentialID
		if resolved, resolveErr := s.resolve(ctx, actor); resolveErr == nil {
			if current, targetErr := s.target(resolved, op.Name, op.Arguments); targetErr == nil && hash(current) == op.Fingerprint {
				record, _ := unwrap(current).(map[string]any)
				previous, _ := record["values"].(map[string]any)
				body, _ := op.Arguments["body"].(map[string]any)
				values, _ := body["values"].(map[string]any)
				selected := map[string]any{}
				for field := range values {
					selected[field] = previous[field]
				}
				op.Before = map[string]any{"id": record["id"], "values": selected}
			}
		}
	}
	return op, err
}
func (s *Service) check(ctx context.Context, a Actor, name string) (context.Context, Policy, error) {
	op, ok := agenttools.Operations[name]
	if !ok {
		return ctx, Policy{}, ErrInvalid
	}
	p, err := s.Policy(ctx, a.Identity)
	if err != nil {
		return ctx, p, err
	}
	deny := func(cause error) (context.Context, Policy, error) {
		err := s.store.WithTransaction(ctx, func(tx storage.Executor) error {
			return s.audit(ctx, tx, a, "agent.operationDenied", a.Identity, "denied")
		})
		if err != nil {
			return ctx, p, err
		}
		return ctx, p, cause
	}
	if !slices.Contains(p.AllowedOperations, op.Permission) || p.Mode == "readOnly" && !agenttools.ReadOnly(name) {
		return deny(ErrForbidden)
	}
	resolved, err := s.resolve(ctx, a)
	if err != nil {
		return deny(ErrForbidden)
	}
	if a.Kind == "serviceAccount" && !serviceaccounts.HasPermission(resolved, permissions.Operation(op.Permission)) {
		return deny(ErrForbidden)
	}
	return resolved, p, nil
}

func (s *Service) invoke(ctx context.Context, name string, args map[string]any) (any, error) {
	call, err := agenttools.BuildCall(name, args)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(call.Body)
	if err != nil {
		return nil, err
	}
	var r io.Reader
	if call.Body != nil {
		r = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, call.Method, call.Path+"?"+call.Query.Encode(), r)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.handler.ServeHTTP(w, request)
	if w.Body.Len() > 2<<20 {
		return nil, fmt.Errorf("响应过大，请缩小查询范围")
	}
	var result any
	decoder := json.NewDecoder(w.Body)
	decoder.UseNumber()
	if w.Body.Len() > 0 {
		if err := decoder.Decode(&result); err != nil {
			return nil, fmt.Errorf("业务 API 返回无效响应")
		}
	}
	if w.Code < 200 || w.Code >= 300 {
		safe, _ := json.Marshal(redact(result))
		return nil, fmt.Errorf("业务 API (%d): %s", w.Code, safe)
	}
	return redact(result), nil
}
func redact(v any) any {
	switch value := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, c := range value {
			if sensitive(k) {
				out[k] = "[已隐藏]"
			} else {
				out[k] = redact(c)
			}
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, c := range value {
			out[i] = redact(c)
		}
		return out
	}
	return v
}
func sensitive(k string) bool {
	k = strings.ToLower(k)
	if k == "emailpasswordenabled" || strings.HasSuffix(k, "secretid") || k == "secretbindings" || strings.HasSuffix(k, "secretname") || strings.HasSuffix(k, "configured") {
		return false
	}
	return strings.Contains(k, "password") || strings.Contains(k, "token") || strings.Contains(k, "secret") || strings.Contains(k, "credential") || strings.Contains(k, "authorization") || strings.Contains(k, "cookie") || strings.Contains(k, "apikey") || strings.Contains(k, "api_key")
}
func hasSensitive(v any) bool {
	switch v := v.(type) {
	case map[string]any:
		for k, c := range v {
			if sensitive(k) || hasSensitive(c) {
				return true
			}
		}
	case []any:
		for _, c := range v {
			if hasSensitive(c) {
				return true
			}
		}
	}
	return false
}
func unwrap(v any) any {
	if m, ok := v.(map[string]any); ok {
		if d, exists := m["data"]; exists {
			return d
		}
	}
	return v
}
func hash(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func (s *Service) target(ctx context.Context, name string, args map[string]any) (any, error) {
	read := ""
	ids := map[string]any{}
	for key, value := range args {
		if strings.HasSuffix(key, "Id") {
			ids[key] = value
		}
	}
	switch {
	case strings.HasPrefix(name, "records_"):
		read = "records_get"
		if name == "records_create" {
			read = "collections_get"
			delete(ids, "recordId")
		}
	case strings.HasPrefix(name, "schema_"):
		read = "schema_pending_get"
		delete(ids, "operationId")
	case strings.HasPrefix(name, "access_rules_"):
		read = "access_rules_get"
	case strings.HasPrefix(name, "authentication_"):
		read = "authentication_get"
	default:
		for _, prefix := range []string{"hooks", "webhooks", "event_hooks", "jobs", "deliveries"} {
			if strings.HasPrefix(name, prefix+"_") {
				read = prefix + "_get"
				if strings.HasSuffix(name, "_create") {
					read = prefix + "_list"
				}
				break
			}
		}
	}
	if read == "" {
		if name == "collections_create" {
			return s.invoke(ctx, "collections_list", map[string]any{"limit": json.Number("100")})
		}
		return nil, nil
	}
	result, err := s.invoke(ctx, read, ids)
	if err != nil {
		return nil, err
	}
	if name == "schema_apply" {
		preview, err := s.invoke(ctx, "schema_preview", map[string]any{"collectionId": args["collectionId"], "body": args["body"]})
		if err != nil {
			return nil, err
		}
		return map[string]any{"pending": unwrap(result), "preview": unwrap(preview)}, nil
	}
	if strings.HasPrefix(name, "schema_operation_") {
		collection, err := s.invoke(ctx, "collections_get", map[string]any{"collectionId": args["collectionId"]})
		if err != nil {
			return nil, err
		}
		return map[string]any{"pending": unwrap(result), "collection": unwrap(collection)}, nil
	}
	return result, nil
}
func enabled(v any) bool {
	m, ok := unwrap(v).(map[string]any)
	if !ok {
		return false
	}
	b, _ := m["enabled"].(bool)
	return b
}
func (s *Service) Call(ctx context.Context, sessionID string, a Actor, name string, args map[string]any) (Operation, error) {
	session, err := s.GetSession(ctx, sessionID, a)
	if err != nil {
		return Operation{}, err
	}
	if session.Actor.Identity != a.Identity || session.Actor.ID != a.ID {
		return Operation{}, ErrForbidden
	}
	a.KeyID = session.CredentialID
	resolved, p, err := s.check(ctx, a, name)
	if err != nil {
		return Operation{}, err
	}
	if _, err := agenttools.BuildCall(name, args); err != nil {
		return Operation{}, err
	}
	if hasSensitive(args) {
		return Operation{}, fmt.Errorf("敏感凭据不能作为 Agent 工具参数，请在原页面配置")
	}
	if name == "records_list" || name == "records_get" {
		return s.readRecords(resolved, session, a, name, args)
	}
	requestID := httpapi.RequestID(ctx)
	if requestID == "" {
		requestID = newID("req_")
	}
	op := Operation{ID: newID("ago_"), SessionID: sessionID, Name: name, Title: agenttools.Operations[name].Purpose, Arguments: args, Actor: a, State: "awaitingApproval", CreatedAt: now(), RequestID: requestID, PolicyRevision: p.Revision, CredentialID: a.KeyID}
	if agenttools.ReadOnly(name) {
		result, err := s.invoke(resolved, name, args)
		if err != nil {
			return op, err
		}
		op.State = "succeeded"
		op.Result = result
		return op, s.persistOperation(ctx, op)
	}
	before, err := s.target(resolved, name, args)
	if err != nil {
		return op, err
	}
	op.Before = before
	if name == "collections_create" {
		op.Before = map[string]any{"name": args["body"].(map[string]any)["name"]}
	}
	if strings.HasPrefix(name, "records_") {
		op.Before = map[string]any{"fingerprint": hash(before)}
	}

	op.Fingerprint = hash(before)
	op.Risk = agenttools.AlwaysConfirm(name) || s.recordSideEffects(resolved, name, args)
	// 未确认的执行结果不能由模型自动重试；Owner 复核后成功的下一步才能解除该目标的恢复限制。
	for i := len(session.Operations) - 1; i >= 0; i-- {
		previous := session.Operations[i]
		if agenttools.ReadOnly(previous.Name) || targetKey(previous) != targetKey(op) {
			continue
		}
		if previous.State == "succeeded" {
			break
		}
		if previous.State == "failed" || previous.State == "executing" || previous.State == "interrupted" {
			op.Risk = true
			op.Error = "此前写入的结果需要核验，请检查当前目标后确认，不能自动重试。"
			break
		}
	}
	if strings.HasSuffix(name, "_update") && (strings.HasPrefix(name, "hooks_") || strings.HasPrefix(name, "webhooks_") || strings.HasPrefix(name, "event_hooks_") || strings.HasPrefix(name, "jobs_")) {
		op.Risk = op.Risk || enabled(before)
	}
	if body, ok := args["body"].(map[string]any); ok {
		if b, _ := body["enabled"].(bool); b {
			op.Risk = true
		}
		if name == "collections_create" && (body["accessRules"] != nil || body["authentication"] != nil) {
			op.Risk = true
		}
	}
	if err := s.persistOperation(ctx, op); err != nil {
		return op, err
	}
	if p.Mode == "autoWrites" && !op.Risk && slices.Contains(p.AutoOperations, agenttools.Operations[name].Permission) {
		return s.execute(ctx, op, false, a)
	}
	return op, nil
}
func (s *Service) persistOperation(ctx context.Context, op Operation) error {
	ctx = httpapi.WithRequestID(ctx, op.RequestID)
	body, err := json.Marshal(op)
	if err != nil {
		return err
	}
	err = s.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO modelry_agent_operations(id,session_id,state,body,fingerprint,credential_id) VALUES(?,?,?,?,?,?)`, op.ID, op.SessionID, op.State, string(body), op.Fingerprint, op.CredentialID); err != nil {
			return err
		}
		return s.audit(ctx, tx, op.Actor, "agent.operationProposed", op.ID, op.State)
	})
	if err != nil {
		return err
	}
	return s.updateSession(ctx, op.SessionID, func(v *Session) error {
		v.Operations = append(v.Operations, op)
		if op.State == "awaitingApproval" {
			v.State = "awaitingApproval"
		}
		return nil
	})
}
func (s *Service) finish(ctx context.Context, op Operation) error {
	ctx = httpapi.WithRequestID(ctx, op.RequestID)
	body, err := json.Marshal(op)
	if err != nil {
		return err
	}
	err = s.store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `UPDATE modelry_agent_operations SET state=?,body=? WHERE id=?`, op.State, string(body), op.ID); err != nil {
			return err
		}
		return s.audit(ctx, tx, op.Actor, "agent.operationFinished", op.ID, op.State)
	})
	if err != nil {
		return err
	}
	return s.updateSession(ctx, op.SessionID, func(v *Session) error {
		for i := range v.Operations {
			if v.Operations[i].ID == op.ID {
				v.Operations[i] = op
				break
			}
		}
		if v.Actor.Identity != "builtin" {
			v.State = "completed"
			for _, item := range v.Operations {
				if item.State == "awaitingApproval" || item.State == "executing" {
					v.State = "awaitingApproval"
					break
				}
			}
		}
		return nil
	})
}
func (s *Service) Approve(ctx context.Context, id string, approver Actor) (Operation, error) {
	if approver.Kind != "owner" {
		return Operation{}, ErrForbidden
	}
	op, err := s.GetOperation(ctx, id, approver)
	if err != nil {
		return op, err
	}
	if op.State != "awaitingApproval" {
		return op, nil
	}
	return s.execute(ctx, op, true, approver)
}
func (s *Service) execute(ctx context.Context, op Operation, approved bool, approver Actor, expectedFingerprint ...string) (Operation, error) {
	unlock, lockErr := s.lockMutation(ctx)
	if lockErr != nil {
		return op, lockErr
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return op, err
	}
	s.executeMu.Lock()
	defer s.executeMu.Unlock()
	current, err := s.GetOperation(ctx, op.ID, op.Actor)
	if err != nil {
		return op, err
	}
	if current.State != "awaitingApproval" {
		return current, nil
	}
	op = current
	if len(expectedFingerprint) == 1 {
		op.Fingerprint = expectedFingerprint[0]
	}
	op.Actor.KeyID = op.CredentialID
	resolved, p, err := s.check(ctx, op.Actor, op.Name)
	if err != nil {
		op.State = "stale"
		op.Error = err.Error()
		return op, s.finish(ctx, op)
	}
	if p.Revision != op.PolicyRevision {
		op.State = "stale"
		op.Error = ErrConflict.Error()
		return op, s.finish(ctx, op)
	}
	before, err := s.target(resolved, op.Name, op.Arguments)
	if err != nil || hash(before) != op.Fingerprint {
		op.State = "stale"
		op.Error = ErrConflict.Error()
		return op, s.finish(ctx, op)
	}
	err = s.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE modelry_agent_operations SET state='executing' WHERE id=? AND state='awaitingApproval'`, op.ID)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrConflict
		}
		if approved {
			op.ApproverID = approver.ID
			return s.audit(ctx, tx, approver, "agent.operationApproved", op.ID, "success")
		}
		return nil
	})
	if errors.Is(err, ErrConflict) {
		return s.GetOperation(ctx, op.ID, approver)
	}
	if err != nil {
		return op, err
	}
	result, err := s.invoke(httpapi.WithRequestID(resolved, op.RequestID), op.Name, op.Arguments)
	op.State = "succeeded"
	op.Error = ""
	if err != nil {
		op.State = "failed"
		op.Error = err.Error()
	}
	op.Result = result
	// 记录写入响应含业务值，不落盘；模型仅获得标识和明确结果。
	if strings.HasPrefix(op.Name, "records_") {
		if m, ok := unwrap(result).(map[string]any); ok {
			op.Result = map[string]any{"id": m["id"], "state": op.State}
		}
		op.Before = map[string]any{"fingerprint": op.Fingerprint}
	}
	return op, s.finish(context.WithoutCancel(ctx), op)
}
func (s *Service) Reject(ctx context.Context, id string, a Actor) (Operation, error) {
	if a.Kind != "owner" {
		return Operation{}, ErrForbidden
	}
	op, err := s.GetOperation(ctx, id, a)
	if err != nil {
		return op, err
	}
	if op.State != "awaitingApproval" {
		return op, nil
	}
	claimed := false
	err = s.store.WithTransaction(ctx, func(tx storage.Executor) error {
		result, err := tx.ExecContext(ctx, `UPDATE modelry_agent_operations SET state='rejected' WHERE id=? AND state='awaitingApproval'`, id)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		claimed = n == 1
		if err == nil && claimed {
			return s.audit(ctx, tx, a, "agent.operationRejected", id, "success")
		}
		return err
	})
	if err != nil {
		return op, err
	}
	if !claimed {
		return s.GetOperation(ctx, id, a)
	}
	op.State = "rejected"
	op.ApproverID = a.ID
	return op, s.finish(ctx, op)
}

func (s *Service) Grant(ctx context.Context, id string, g DataGrant, a Actor) error {
	if a.Kind != "owner" {
		return ErrForbidden
	}
	if g.CollectionID == "" || len(g.Fields) == 0 || len(g.Fields) > 100 {
		return ErrInvalid
	}
	for _, field := range g.Fields {
		if sensitive(field) || field == "*" {
			return ErrInvalid
		}
	}
	return s.updateSession(ctx, id, func(v *Session) error { v.DataGrants = append(v.DataGrants, g); return nil }, func(tx storage.Executor) error { return s.audit(ctx, tx, a, "agent.dataAuthorized", id, "success") })
}
func (s *Service) readRecords(ctx context.Context, v Session, a Actor, name string, args map[string]any) (Operation, error) {
	op := Operation{ID: newID("ago_"), SessionID: v.ID, Name: name, Title: agenttools.Operations[name].Purpose, Actor: a, State: "succeeded", CreatedAt: now(), Arguments: args, RequestID: httpapi.RequestID(ctx), CredentialID: a.KeyID}
	if op.RequestID == "" {
		op.RequestID = newID("req_")
	}
	ctx = httpapi.WithRequestID(ctx, op.RequestID)
	collection, _ := args["collectionId"].(string)
	var fields []string
	for _, g := range v.DataGrants {
		if g.CollectionID == collection {
			fields = append(fields, g.Fields...)
		}
	}
	if len(fields) == 0 {
		if err := s.store.WithTransaction(ctx, func(tx storage.Executor) error { return s.audit(ctx, tx, a, "agent.dataDenied", v.ID, "denied") }); err != nil {
			return op, err
		}
		return op, fmt.Errorf("DATA_APPROVAL_REQUIRED: 请在会话中授权集合 %s 的具体字段", collection)
	}
	if name == "records_list" {
		if current, ok := args["limit"].(json.Number); ok {
			n, err := current.Int64()
			if err != nil || n > 20 {
				args["limit"] = json.Number("20")
			}
		} else {
			args["limit"] = json.Number("20")
		}
	}
	result, err := s.invoke(ctx, name, args)
	if err != nil {
		return op, err
	}
	filter := func(value any) any {
		m, ok := value.(map[string]any)
		if !ok {
			return value
		}
		out := map[string]any{}
		for _, k := range []string{"id", "createdAt", "updatedAt"} {
			if m[k] != nil {
				out[k] = m[k]
			}
		}
		if values, ok := m["values"].(map[string]any); ok {
			selected := map[string]any{}
			for _, k := range fields {
				if value, exists := values[k]; !sensitive(k) && exists {
					selected[k] = value
				}
			}
			out["values"] = selected
		}
		return out
	}
	switch data := unwrap(result).(type) {
	case []any:
		for i, item := range data {
			data[i] = filter(item)
		}
		op.Result = map[string]any{"data": data}
	case map[string]any:
		op.Result = map[string]any{"data": filter(data)}
	}
	if envelope, ok := result.(map[string]any); ok && name == "records_list" {
		if cursor, ok := envelope["nextCursor"].(string); ok {
			op.Result.(map[string]any)["nextCursor"] = cursor
		}
	}
	transient := op.Result
	op.Result = map[string]any{"data": "业务记录未保存到会话历史"}
	err = s.persistOperation(ctx, op)
	op.Result = transient
	return op, err
}
