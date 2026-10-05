package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/liujingwen1225/modelry/internal/agenttools"
	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Config struct {
	BaseURL          string `json:"baseUrl"`
	Model            string `json:"model"`
	APIKeyConfigured bool   `json:"apiKeyConfigured"`
	Revision         int    `json:"revision"`
	SecretID         string `json:"secretId,omitempty"`
}
type ConfigInput struct {
	BaseURL     string `json:"baseUrl"`
	Model       string `json:"model"`
	APIKey      string `json:"apiKey,omitempty"`
	ClearAPIKey bool   `json:"clearApiKey,omitempty"`
	Revision    int    `json:"revision"`
}

func (s *Service) Config(ctx context.Context) (Config, error) {
	c := Config{BaseURL: "https://api.deepseek.com", Model: "deepseek-flash"}
	err := s.store.WithReadSnapshot(ctx, func(tx storage.Executor) error {
		err := readDocument(ctx, tx, "config", "model", &c)
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	})
	if err == nil && c.SecretID != "" && s.secrets != nil {
		_, c.APIKeyConfigured, err = s.secrets.SecretMetadata(ctx, c.SecretID)
	}
	return c, err
}
func (s *Service) SaveConfig(ctx context.Context, in ConfigInput, a Actor) (Config, error) {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	if a.Kind != "owner" {
		return Config{}, ErrForbidden
	}
	base := strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(base) > 2048 || strings.TrimSpace(in.Model) == "" || len(in.Model) > 200 || in.ClearAPIKey && in.APIKey != "" || strings.ContainsAny(in.APIKey, "\r\n") {
		return Config{}, ErrInvalid
	}
	old, err := s.Config(ctx)
	if err != nil {
		return old, err
	}
	if old.Revision != in.Revision {
		return old, ErrConflict
	}
	c := old
	c.BaseURL, c.Model, c.Revision = base, strings.TrimSpace(in.Model), old.Revision+1
	if in.APIKey != "" {
		if s.secrets == nil {
			return c, ErrInvalid
		}
		if old.SecretID == "" {
			secret, err := s.secrets.CreateSecret(ctx, "Modelry Agent 模型密钥", in.APIKey)
			if err != nil {
				return c, err
			}
			c.SecretID = secret.ID
		} else {
			if _, err := s.secrets.ReplaceSecretValue(ctx, old.SecretID, in.APIKey); err != nil {
				return c, err
			}
		}
		c.APIKeyConfigured = true
	}
	if in.ClearAPIKey {
		if old.SecretID != "" {
			if err := s.secrets.DeleteSecret(ctx, old.SecretID); err != nil {
				return c, err
			}
		}
		c.APIKeyConfigured = false
		c.SecretID = ""
	}
	err = s.store.WithTransaction(ctx, func(tx storage.Executor) error {
		var current Config
		if err := readDocument(ctx, tx, "config", "model", &current); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		if current.Revision != in.Revision {
			return ErrConflict
		}
		if err := putDocument(ctx, tx, "config", "model", c); err != nil {
			return err
		}
		return s.audit(ctx, tx, a, "agent.modelConfigured", "model", "success")
	})
	return c, err
}

type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}
type chatMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Reasoning  string     `json:"reasoning_content,omitempty"`
}

func modelRequest(ctx context.Context, c Config, key []byte, messages []chatMessage, tools bool) (chatMessage, error) {
	payload := map[string]any{"model": c.Model, "messages": messages, "stream": false, "max_tokens": 4096}
	if tools {
		var definitions []any
		for _, tool := range agenttools.Tools() {
			definitions = append(definitions, map[string]any{"type": "function", "function": map[string]any{"name": tool.Name, "description": tool.Description, "parameters": tool.InputSchema}})
		}
		payload["tools"] = definitions
	}
	// DeepSeek 默认思考模式的工具回合需要 reasoning_content；保留在本次调用内存中，不展示或落盘。
	body, err := json.Marshal(payload)
	if err != nil {
		return chatMessage{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return chatMessage{}, ErrInvalid
	}
	request.Header.Set("Content-Type", "application/json")
	if len(key) > 0 {
		request.Header.Set("Authorization", "Bearer "+string(key))
	}
	client := http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return chatMessage{}, fmt.Errorf("模型连接失败，请检查 API 地址与网络")
	}
	defer response.Body.Close()
	b, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(b) > 2<<20 {
		return chatMessage{}, fmt.Errorf("模型响应过大或无法读取")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return chatMessage{}, fmt.Errorf("模型服务返回 HTTP %d，请检查密钥、模型名称与服务状态", response.StatusCode)
	}
	var result struct {
		Choices []struct {
			Message      chatMessage `json:"message"`
			FinishReason string      `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(b, &result); err != nil || len(result.Choices) == 0 {
		return chatMessage{}, fmt.Errorf("模型返回了无效响应")
	}
	if result.Choices[0].FinishReason == "length" {
		return chatMessage{}, fmt.Errorf("模型响应达到长度限制，请缩小任务后继续")
	}
	return result.Choices[0].Message, nil
}
func (s *Service) withModelKey(ctx context.Context, c Config, run func([]byte) error) error {
	if !c.APIKeyConfigured || c.SecretID == "" {
		return run(nil)
	}
	return s.secrets.WithSecretValue(ctx, c.SecretID, run)
}
func (s *Service) TestModel(ctx context.Context) error {
	c, err := s.Config(ctx)
	if err != nil {
		return err
	}
	return s.withModelKey(ctx, c, func(key []byte) error {
		_, err := modelRequest(ctx, c, key, []chatMessage{{Role: "user", Content: "只回复 OK"}}, false)
		return err
	})
}
func (s *Service) Start(ctx context.Context, id, content, page string, a Actor) error {
	if a.Kind != "owner" || a.Identity != "builtin" {
		return ErrForbidden
	}
	if len(strings.TrimSpace(content)) == 0 || len(content) > 16000 || len(page) > 2048 {
		return ErrInvalid
	}
	session, err := s.GetSession(ctx, id, a)
	if err != nil {
		return err
	}
	if session.Actor.Identity != "builtin" || session.Actor.ID != a.ID {
		return ErrForbidden
	}

	s.configMu.Lock()
	c, err := s.Config(ctx)
	var frozenKey []byte
	if err == nil && c.Revision == 0 {
		err = fmt.Errorf("请先在设置中保存模型配置")
	}
	if err == nil {
		err = s.withModelKey(ctx, c, func(key []byte) error { frozenKey = append([]byte(nil), key...); return nil })
	}
	s.configMu.Unlock()
	if err != nil {
		return err
	}

	s.mu.Lock()
	if s.closed || s.runs[id] != nil {
		s.mu.Unlock()
		clear(frozenKey)
		return ErrConflict
	}
	runCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Minute)
	s.runs[id] = cancel
	s.wg.Add(1)
	s.mu.Unlock()
	err = s.updateSession(ctx, id, func(v *Session) error {
		v.State = "running"
		v.PageContext = page
		v.Messages = append(v.Messages, Message{Role: "user", Content: content})
		if v.Title == "Agent" {
			v.Title = content
			if len(v.Title) > 120 {
				v.Title = string([]rune(content)[:min(40, len([]rune(content)))])
			}
		}
		return nil
	})
	if err != nil {
		cancel()
		s.mu.Lock()
		delete(s.runs, id)
		s.mu.Unlock()
		s.wg.Done()
		clear(frozenKey)
		return err
	}
	go func() {
		defer s.wg.Done()
		defer clear(frozenKey)
		defer cancel()
		defer func() { s.mu.Lock(); delete(s.runs, id); s.mu.Unlock() }()
		err := s.loop(runCtx, id, a, frozenKey, c)
		if err != nil {
			s.updateSession(context.Background(), id, func(v *Session) error {
				if v.State != "cancelled" {
					v.State = "failed"
					if runCtx.Err() != nil {
						v.State = "paused"
						s.mu.Lock()
						if s.closed {
							v.State = "interrupted"
						}
						s.mu.Unlock()
					}
					v.Messages = append(v.Messages, Message{Role: "assistant", Content: err.Error()})
				}
				return nil
			})
		}
	}()
	return nil
}
func (s *Service) loop(ctx context.Context, id string, a Actor, key []byte, c Config) error {
	session, err := s.GetSession(ctx, id, a)
	if err != nil {
		return err
	}
	messages := []chatMessage{{Role: "system", Content: `你是 Modelry 后端工作台助手，永远用中文回答。仅使用提供的业务工具；无权限时解释恢复路径，不能绕过校验。写入工具可能返回等待 Owner 确认，不能自行确认。没有工具成功证据不能声称已完成。所有字段类型与请求 DTO 按标准 Modelry API 使用；集合类型必须是区分大小写的 Normal 或 Auth；字段类型仅为 text/number/boolean/dateTime/json/relation/file/files。业务数据授权不足时提示用户在会话里授权指定集合和字段。不向用户展示思考过程。用简短段落回答，不使用 Markdown 标题、表格或代码块。工具结果有 approverId 表示 Owner 已确认，不能声称无需确认；结果链接使用 /collections/{集合ID}。当前页面上下文：` + session.PageContext}}
	// 恢复任务时提供耐久步骤摘要，不能让模型把中断或已完成写入当成可重试调用。
	steps := []map[string]any{}
	for _, op := range session.Operations[max(0, len(session.Operations)-20):] {
		steps = append(steps, map[string]any{"operationId": op.ID, "tool": op.Name, "state": op.State, "arguments": op.Arguments, "result": op.Result, "error": op.Error, "approverId": op.ApproverID})
	}
	if len(steps) > 0 {
		encoded, _ := json.Marshal(steps)
		if len(encoded) <= 64000 {
			messages = append(messages, chatMessage{Role: "system", Content: "以下是此前耐久步骤。不要重复已完成写入；interrupted 是结果不确定，先检查当前状态，不能自动重放写入：" + string(encoded)})
		}
	}
	for _, message := range session.Messages[max(0, len(session.Messages)-40):] {
		messages = append(messages, chatMessage{Role: message.Role, Content: message.Content})
	}
	calls := 0
	for rounds := 0; rounds < 21; rounds++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		reply, err := modelRequest(ctx, c, key, messages, true)
		if err != nil {
			return err
		}
		messages = append(messages, reply)
		if reply.Content != "" {
			if err := s.updateSession(ctx, id, func(v *Session) error {
				v.Messages = append(v.Messages, Message{Role: "assistant", Content: reply.Content})
				return nil
			}); err != nil {
				return err
			}
		}
		if len(reply.ToolCalls) == 0 {
			return s.updateSession(ctx, id, func(v *Session) error { v.State = "completed"; return nil })
		}
		if calls+len(reply.ToolCalls) > 20 {
			return s.updateSession(ctx, id, func(v *Session) error {
				v.State = "paused"
				v.Messages = append(v.Messages, Message{Role: "assistant", Content: "已达到本轮 20 次工具调用上限，已完成的结果保留。可继续任务。"})
				return nil
			})
		}

		type toolResult struct {
			call toolCall
			op   Operation
			err  error
		}
		results := make([]toolResult, 0, len(reply.ToolCalls))
		for _, call := range reply.ToolCalls {
			calls++
			var args map[string]any
			decoder := json.NewDecoder(strings.NewReader(call.Function.Arguments))
			decoder.UseNumber()
			err := decoder.Decode(&args)
			var op Operation
			if err == nil {
				op, err = s.Call(httpapi.WithRequestID(ctx, newID("req_")), id, a, call.Function.Name, args)
			}
			results = append(results, toolResult{call, op, err})
		}
		for _, item := range results {
			var result any
			if item.err != nil {
				result = map[string]any{"error": item.err.Error()}
			} else if item.op.State == "awaitingApproval" {
				if err := s.updateSession(ctx, id, func(v *Session) error { v.State = "awaitingApproval"; return nil }); err != nil {
					return err
				}
				ticker := time.NewTicker(time.Second)
				waiting := true
				for waiting {
					select {
					case <-ctx.Done():
						ticker.Stop()
						return ctx.Err()
					case <-ticker.C:
						current, err := s.GetOperation(ctx, item.op.ID, a)
						if err != nil {
							ticker.Stop()
							return err
						}
						if current.State != "awaitingApproval" && current.State != "executing" {
							result = map[string]any{"operationId": current.ID, "state": current.State, "result": current.Result, "error": current.Error, "approverId": current.ApproverID}
							waiting = false
						}
					}
				}
				ticker.Stop()
				if err := s.updateSession(ctx, id, func(v *Session) error { v.State = "running"; return nil }); err != nil {
					return err
				}
			} else {
				result = item.op.Result
			}
			b, _ := json.Marshal(result)
			if len(b) > 32000 {
				b = []byte(`{"error":"响应过大，请缩小范围"}`)
			}
			messages = append(messages, chatMessage{Role: "tool", ToolCallID: item.call.ID, Content: string(b)})
		}

	}
	return nil
}
func (s *Service) Cancel(ctx context.Context, id string, a Actor) error {
	session, err := s.GetSession(ctx, id, a)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if cancel := s.runs[id]; cancel != nil {
		cancel()
	}
	s.mu.Unlock()
	for _, op := range session.Operations {
		if err := s.store.WithTransaction(ctx, func(tx storage.Executor) error {
			_, err := tx.ExecContext(ctx, `UPDATE modelry_agent_operations SET state='cancelled' WHERE id=? AND state='awaitingApproval'`, op.ID)
			return err
		}); err != nil {
			return err
		}
	}
	return s.updateSession(ctx, id, func(v *Session) error {
		v.State = "cancelled"
		for i := range v.Operations {
			if v.Operations[i].State == "awaitingApproval" {
				v.Operations[i].State = "cancelled"
			}
		}
		return nil
	})
}
