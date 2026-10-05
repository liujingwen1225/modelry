package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/liujingwen1225/modelry/internal/adminauth"
	"github.com/liujingwen1225/modelry/internal/agenttools"
	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Module struct{ service *Service }

func NewModule(s *Service) *Module { return &Module{s} }
func actorFromRequest(r *http.Request) (Actor, error) {
	if owner, ok := adminauth.OwnerFromContext(r.Context()); ok && owner.ID != "" {
		return Actor{Identity: "builtin", Kind: "owner", ID: owner.ID, KeyID: adminauth.AgentCredentialID(r.Context())}, nil
	}
	if principal, ok := authorization.PrincipalFromContext(r.Context()); ok && principal.Type == authorization.PrincipalServiceAccount {
		token := ""
		credentials := strings.Fields(r.Header.Get("Authorization"))
		if len(credentials) == 2 && strings.EqualFold(credentials[0], "Bearer") {
			token = credentials[1]
		}
		parts := strings.SplitN(strings.TrimPrefix(token, "mdl_sk_"), ".", 2)
		key := ""
		if len(parts) == 2 {
			key = parts[0]
		}
		return Actor{Identity: principal.ID, Kind: "serviceAccount", ID: principal.ID, KeyID: key}, nil
	}
	return Actor{}, ErrForbidden
}
func (m *Module) RegisterRoutes(mux *http.ServeMux) {
	register := func(pattern string, owner bool, handler func(http.ResponseWriter, *http.Request, Actor) error) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			a, err := actorFromRequest(r)
			if err == nil && owner && a.Kind != "owner" {
				err = ErrForbidden
			}
			if err == nil {
				err = handler(w, r, a)
			}
			if err != nil {
				writeError(w, r, err)
			}
		})
	}
	register("GET /admin/api/v1/agent/config", true, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		c, err := m.service.Config(r.Context())
		c.SecretID = ""
		if err == nil {
			writeData(w, c)
		}
		return err
	})
	register("PUT /admin/api/v1/agent/config", true, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		var in ConfigInput
		if err := decode(r, &in); err != nil {
			return err
		}
		c, err := m.service.SaveConfig(r.Context(), in, a)
		c.SecretID = ""
		if err == nil {
			writeData(w, c)
		}
		return err
	})
	register("POST /admin/api/v1/agent/config/test", true, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		if err := m.service.TestModel(r.Context()); err != nil {
			return err
		}
		writeData(w, map[string]any{"connected": true})
		return nil
	})
	register("GET /admin/api/v1/agent/tools", false, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		writeData(w, agenttools.Tools())
		return nil
	})
	register("GET /admin/api/v1/agent/policies/{identity}", true, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		v, err := m.service.Policy(r.Context(), r.PathValue("identity"))
		if err == nil {
			writeData(w, v)
		}
		return err
	})
	register("PUT /admin/api/v1/agent/policies/{identity}", true, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		var in Policy
		if err := decode(r, &in); err != nil {
			return err
		}
		v, err := m.service.SavePolicy(r.Context(), r.PathValue("identity"), in, a)
		if err == nil {
			writeData(w, v)
		}
		return err
	})
	register("GET /admin/api/v1/agent/sessions", false, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		v, err := m.service.Sessions(r.Context(), a)
		if err == nil {
			writeData(w, v)
		}
		return err
	})
	register("POST /admin/api/v1/agent/sessions", false, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		var in struct {
			Title string `json:"title"`
		}
		if err := decode(r, &in); err != nil {
			return err
		}
		v, err := m.service.CreateSession(r.Context(), a, in.Title)
		if err == nil {
			writeData(w, v)
		}
		return err
	})
	register("GET /admin/api/v1/agent/sessions/{sessionId}", false, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		v, err := m.service.GetSession(r.Context(), r.PathValue("sessionId"), a)
		if err == nil {

			writeData(w, v)
		}
		return err
	})
	register("POST /admin/api/v1/agent/sessions/{sessionId}/messages", true, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		var in struct {
			Content     string `json:"content"`
			PageContext string `json:"pageContext"`
		}
		if err := decode(r, &in); err != nil {
			return err
		}
		if err := m.service.Start(r.Context(), r.PathValue("sessionId"), in.Content, in.PageContext, a); err != nil {
			return err
		}
		writeData(w, map[string]any{"state": "running"})
		return nil
	})
	register("POST /admin/api/v1/agent/sessions/{sessionId}/tools", false, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		var in struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
			Calls     []struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"calls,omitempty"`
		}
		if err := decode(r, &in); err != nil {
			return err
		}
		id := r.PathValue("sessionId")
		if len(in.Calls) > 0 {
			if len(in.Calls) > 20 || in.Name != "" {
				return ErrInvalid
			}
			var results []Operation
			for _, call := range in.Calls {
				op, err := m.service.Call(r.Context(), id, a, call.Name, call.Arguments)
				if err != nil {
					return err
				}
				results = append(results, op)
			}
			writeData(w, results)
			return nil
		}
		op, err := m.service.Call(r.Context(), id, a, in.Name, in.Arguments)
		if err == nil {
			writeData(w, map[string]any{"operation": op, "approvalRequired": op.State == "awaitingApproval", "operationId": op.ID, "reviewUrl": "/agent?session=" + op.SessionID})
		}
		return err
	})
	register("POST /admin/api/v1/agent/sessions/{sessionId}/cancel", false, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		if err := m.service.Cancel(r.Context(), r.PathValue("sessionId"), a); err != nil {
			return err
		}
		writeData(w, map[string]any{"state": "cancelled"})
		return nil
	})

	register("POST /admin/api/v1/agent/sessions/{sessionId}/approve-batch", true, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		var input struct {
			OperationIDs []string `json:"operationIds"`
		}
		if err := decode(r, &input); err != nil {
			return err
		}
		for _, id := range input.OperationIDs {
			op, err := m.service.GetOperation(r.Context(), id, a)
			if err != nil {
				return err
			}
			if op.SessionID != r.PathValue("sessionId") {
				return ErrInvalid
			}
		}
		result, err := m.service.ApproveBatch(r.Context(), input.OperationIDs, a)
		if err == nil {
			writeData(w, result)
		}
		return err
	})
	register("POST /admin/api/v1/agent/sessions/{sessionId}/data-grants", true, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		var in DataGrant
		if err := decode(r, &in); err != nil {
			return err
		}
		if err := m.service.Grant(r.Context(), r.PathValue("sessionId"), in, a); err != nil {
			return err
		}
		writeData(w, in)
		return nil
	})
	register("GET /admin/api/v1/agent/operations/{operationId}", false, func(w http.ResponseWriter, r *http.Request, a Actor) error {
		v, err := m.service.GetOperation(r.Context(), r.PathValue("operationId"), a)
		if err == nil {
			writeData(w, v)
		}
		return err
	})
	for _, action := range []string{"approve", "reject"} {
		register("POST /admin/api/v1/agent/operations/{operationId}/"+action, true, func(w http.ResponseWriter, r *http.Request, a Actor) error {
			var v Operation
			var err error
			if action == "approve" {
				v, err = m.service.Approve(r.Context(), r.PathValue("operationId"), a)
			} else {
				v, err = m.service.Reject(r.Context(), r.PathValue("operationId"), a)
			}
			if err == nil {
				writeData(w, v)
			}
			return err
		})
	}
	register("GET /admin/api/v1/agent/sessions/{sessionId}/events", false, m.events)
}
func decode(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.UseNumber()
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return ErrInvalid
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return ErrInvalid
	}
	return nil
}
func writeData(w http.ResponseWriter, data any) {
	httpapi.WriteAPIJSON(w, http.StatusOK, map[string]any{"data": data})
}
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	code, status := "AGENT_ERROR", http.StatusBadRequest
	if errors.Is(err, ErrForbidden) {
		code, status = "FORBIDDEN", http.StatusForbidden
	}
	if errors.Is(err, ErrConflict) {
		code, status = "CONFLICT", http.StatusConflict
	}
	if errors.Is(err, ErrNotFound) {
		code, status = "NOT_FOUND", http.StatusNotFound
	}
	httpapi.WriteAPIError(w, r, status, httpapi.APIError{Code: code, Message: err.Error(), Hint: "检查权限、当前状态或模型设置后重试"})
}
func (m *Module) events(w http.ResponseWriter, r *http.Request, a Actor) error {
	id := r.PathValue("sessionId")
	if _, err := m.service.GetSession(r.Context(), id, a); err != nil {
		return err
	}
	last, _ := strconv.Atoi(r.Header.Get("Last-Event-ID"))
	if value, err := strconv.Atoi(r.URL.Query().Get("after")); err == nil && value > last {
		last = value
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		v, err := m.service.GetSession(r.Context(), id, a)
		if err != nil {
			return nil
		}
		if v.Sequence > last {
			b, _ := json.Marshal(v)
			fmt.Fprintf(w, "id: %d\nevent: session\ndata: %s\n\n", v.Sequence, b)
			last = v.Sequence
		} else {
			fmt.Fprint(w, ": heartbeat\n\n")
		}
		if err := http.NewResponseController(w).Flush(); err != nil {
			return nil
		}
		select {
		case <-m.service.done:
			return nil
		case <-r.Context().Done():
			return nil
		case <-ticker.C:
		}
	}
}
