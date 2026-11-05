// Package projectprefs 保存 Figma「设置 · 本地项目」里「基本设置」标签的产品偏好。
//
// 这些是项目级展示偏好，与 Runtime Settings（监听地址 / 请求保留天数）分离：
// 后者决定进程行为，前者只影响工作台的呈现与反馈，重启不改变运行时行为。
package projectprefs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/httpapi"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const maximumRequestBytes = 1 << 20

type transactionalStore interface {
	WithTransaction(context.Context, func(storage.Executor) error) error
	WithReadSnapshot(context.Context, func(storage.Executor) error) error
}

type Preferences struct {
	ProjectName        string `json:"projectName"`
	ProjectDescription string `json:"projectDescription"`
	Locale             string `json:"locale"`
	Appearance         string `json:"appearance"`
	SaveFeedback       bool   `json:"saveFeedback"`
	Revision           int    `json:"revision"`
	UpdatedAt          string `json:"updatedAt"`
}

type updateInput struct {
	ExpectedRevision   int    `json:"expectedRevision"`
	ProjectName        string `json:"projectName"`
	ProjectDescription string `json:"projectDescription"`
	Locale             string `json:"locale"`
	Appearance         string `json:"appearance"`
	SaveFeedback       bool   `json:"saveFeedback"`
}

type Module struct {
	store transactionalStore
}

func NewModule(ctx context.Context, store transactionalStore) (*Module, error) {
	if store == nil {
		return nil, errors.New("project preferences require a store")
	}
	module := &Module{store: store}
	err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS modelry_project_preferences (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			project_name TEXT NOT NULL DEFAULT '',
			project_description TEXT NOT NULL DEFAULT '',
			locale TEXT NOT NULL DEFAULT 'zh-CN',
			appearance TEXT NOT NULL DEFAULT 'light',
			save_feedback INTEGER NOT NULL DEFAULT 1,
			revision INTEGER NOT NULL DEFAULT 1,
			updated_at TEXT NOT NULL
		)`); err != nil {
			return fmt.Errorf("initialize project preferences: %w", err)
		}
		_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO modelry_project_preferences
			(id, project_name, project_description, locale, appearance, save_feedback, revision, updated_at)
			VALUES (1, '', '', 'zh-CN', 'light', 1, 1, ?)`, time.Now().UTC().Format(time.RFC3339Nano))
		return err
	})
	if err != nil {
		return nil, err
	}
	return module, nil
}

func (module *Module) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /admin/api/v1/project-preferences", module.get)
	mux.HandleFunc("PUT /admin/api/v1/project-preferences", module.update)
}

func (module *Module) get(w http.ResponseWriter, request *http.Request) {
	var prefs Preferences
	err := module.store.WithReadSnapshot(request.Context(), func(snapshot storage.Executor) error {
		return scanPreferences(request.Context(), snapshot, &prefs)
	})
	if err != nil {
		writeProblem(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "无法读取项目基本设置。")
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, struct {
		Data Preferences `json:"data"`
	}{Data: prefs})
}

func (module *Module) update(w http.ResponseWriter, request *http.Request) {
	var input updateInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, request.Body, maximumRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeProblem(w, request, http.StatusBadRequest, "INVALID_ARGUMENT", "请求体不是受支持的 JSON。")
		return
	}
	if err := validate(input); err != nil {
		writeProblem(w, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", err.Error(), "请修正标出的设置值后再保存。")
		return
	}
	var prefs Preferences
	err := module.store.WithTransaction(request.Context(), func(tx storage.Executor) error {
		var current int
		if err := tx.QueryRowContext(request.Context(),
			`SELECT revision FROM modelry_project_preferences WHERE id = 1`,
		).Scan(&current); err != nil {
			return err
		}
		if input.ExpectedRevision != current {
			return errConflict
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		feedback := 0
		if input.SaveFeedback {
			feedback = 1
		}
		_, err := tx.ExecContext(request.Context(), `UPDATE modelry_project_preferences SET
			project_name = ?, project_description = ?, locale = ?, appearance = ?,
			save_feedback = ?, revision = revision + 1, updated_at = ? WHERE id = 1`,
			strings.TrimSpace(input.ProjectName), strings.TrimSpace(input.ProjectDescription),
			input.Locale, input.Appearance, feedback, now)
		if err != nil {
			return err
		}
		return scanPreferences(request.Context(), tx, &prefs)
	})
	if err != nil {
		if errors.Is(err, errConflict) {
			writeProblem(w, request, http.StatusConflict, "CONFLICT", "设置已被其它操作更新，请重新读取后再保存。")
			return
		}
		writeProblem(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "无法保存项目基本设置。")
		return
	}
	httpapi.WriteAPIJSON(w, http.StatusOK, struct {
		Data Preferences `json:"data"`
	}{Data: prefs})
}

var errConflict = errors.New("project preferences revision conflict")

func validate(input updateInput) error {
	if len([]rune(strings.TrimSpace(input.ProjectName))) > 64 {
		return errors.New("项目名称不能超过 64 个字符。")
	}
	if len([]rune(strings.TrimSpace(input.ProjectDescription))) > 256 {
		return errors.New("项目说明不能超过 256 个字符。")
	}
	switch input.Locale {
	case "zh-CN", "en-US":
	default:
		return errors.New("工作台语言只支持 zh-CN 或 en-US。")
	}
	switch input.Appearance {
	case "light", "dark", "system":
	default:
		return errors.New("外观只支持 light / dark / system。")
	}
	return nil
}

func scanPreferences(ctx context.Context, query storage.Executor, target *Preferences) error {
	var feedback int
	err := query.QueryRowContext(ctx, `SELECT project_name, project_description, locale, appearance,
		save_feedback, revision, updated_at FROM modelry_project_preferences WHERE id = 1`,
	).Scan(&target.ProjectName, &target.ProjectDescription, &target.Locale, &target.Appearance,
		&feedback, &target.Revision, &target.UpdatedAt)
	if err != nil {
		return err
	}
	target.SaveFeedback = feedback == 1
	return nil
}

func writeProblem(w http.ResponseWriter, request *http.Request, status int, code, message string, hint ...string) {
	problem := httpapi.APIError{Code: code, Message: message}
	if len(hint) > 0 {
		problem.Hint = hint[0]
	}
	httpapi.WriteAPIError(w, request, status, problem)
}

var _ httpapi.APIModule = (*Module)(nil)
