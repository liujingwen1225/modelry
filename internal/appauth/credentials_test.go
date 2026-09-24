package appauth

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/authorization"
	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestCredentialsSessionsAndProfileWritesAreDurableAndAtomic(t *testing.T) {
	ctx := context.Background()
	store := openAuthStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	collection, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{
		Name: "Members", Type: backendmodel.CollectionTypeAuth,
		Fields: []backendmodel.Field{{Name: "displayName", Type: backendmodel.FieldTypeText}},
	})
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := records.New(store, models)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, models, profiles)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Register(ctx, collection.Name, map[string]any{"email": "bob@example.com", "displayName": "Bob"}, "bob-secret"); !errors.Is(err, ErrRegistrationDisabled) {
		t.Fatalf("self registration was not disabled by default: %v", err)
	}
	alice, err := service.CreateUser(ctx, collection.ID, map[string]any{"email": "Alice@example.com", "displayName": "Alice"}, "alice-secret")
	if err != nil {
		t.Fatal(err)
	}
	profile, err := profiles.Get(ctx, collection.ID, alice.ID)
	if err != nil || profile.Values["displayName"] != "Alice" || profile.Values["email"] != "alice@example.com" {
		t.Fatalf("admin user profile was not validated/canonicalized: profile=%+v err=%v", profile, err)
	}
	if _, hasPassword := profile.Values["password"]; hasPassword {
		t.Fatal("Password Credential leaked into the Profile Record")
	}
	if _, err := service.CreateUser(ctx, collection.ID, map[string]any{"email": "ALICE@example.com"}, "another-secret"); !errors.Is(err, ErrConflict) {
		t.Fatalf("case-insensitive email duplicate should conflict: %v", err)
	}
	users, err := service.ListUsers(ctx, collection.ID, records.ListOptions{})
	if err != nil || len(users.Data) != 1 || users.Data[0].RecordID != alice.ID {
		t.Fatalf("atomic profile+credential create was not visible as an App User: users=%+v err=%v", users, err)
	}

	configuration, err := service.GetConfiguration(ctx, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 保存操作只能创建待应用配置，不能立即改变当前生效的默认值。
	state, err := service.SaveConfiguration(ctx, collection.ID, AuthConfigSaveInput{ExpectedVersion: configuration.Version, Configuration: AuthConfig{EmailPasswordEnabled: true, SelfRegistration: true, SessionDurationDays: 7}})
	if err != nil || !state.HasPending {
		t.Fatalf("could not create registration configuration pending state: state=%+v err=%v", state, err)
	}
	state, err = service.ApplyConfiguration(ctx, collection.ID, state.Version)
	if err != nil || !state.Applied.SelfRegistration {
		t.Fatalf("could not apply registration configuration: state=%+v err=%v", state, err)
	}
	bob, err := service.Register(ctx, collection.Name, map[string]any{"email": "bob@example.com", "displayName": "Bob"}, "bob-secret")
	if err != nil {
		t.Fatalf("registration did not atomically create an App User: %v", err)
	}
	login, err := service.Login(ctx, collection.Name, "BOB@example.com", "bob-secret")
	if err != nil || login.AccessToken == "" || login.TokenType != "Bearer" || login.Session.Status != "active" {
		t.Fatalf("Login did not issue a revocable App Session: result=%+v err=%v", login, err)
	}
	var rawTokenRows int
	if err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
		return snapshot.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_app_sessions WHERE token_hash = ?`, []byte(login.AccessToken)).Scan(&rawTokenRows)
	}); err != nil {
		t.Fatal(err)
	}
	if rawTokenRows != 0 {
		t.Fatal("raw one-time Session Token was stored instead of only its hash")
	}
	principal, err := service.AuthenticateSession(ctx, login.AccessToken)
	if err != nil || principal.Type != authorization.PrincipalApplication || principal.ID != bob.ID {
		t.Fatalf("valid App Session did not authenticate to its profile: principal=%+v err=%v", principal, err)
	}
	current, err := service.GetSession(ctx, collection.Name, login.AccessToken)
	if err != nil || current.ID != login.Session.ID || current.Status != "active" {
		t.Fatalf("Session read did not return the active current Session: session=%+v err=%v", current, err)
	}
	sessions, err := service.ListOwnSessions(ctx, collection.Name, login.AccessToken)
	if err != nil || len(sessions) != 1 || sessions[0].ID != login.Session.ID {
		t.Fatalf("current App User Sessions are not visible: sessions=%+v err=%v", sessions, err)
	}
	if _, err := service.Login(ctx, collection.Name, "bob@example.com", "wrong-password"); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("wrong password should return the generic UNAUTHENTICATED boundary: %v", err)
	}
	if err := service.ChangePassword(ctx, collection.Name, login.AccessToken, "bad-current", "bob-new-secret"); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("wrong current password should not change the credential: %v", err)
	}
	if err := service.ChangePassword(ctx, collection.Name, login.AccessToken, "bob-secret", "bob-new-secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AuthenticateSession(ctx, login.AccessToken); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("password change did not revoke all Sessions: %v", err)
	}
	if _, err := service.Login(ctx, collection.Name, "bob@example.com", "bob-secret"); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("old password remained valid after change: %v", err)
	}
	newLogin, err := service.Login(ctx, collection.Name, "bob@example.com", "bob-new-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.RevokeOwnSession(ctx, collection.Name, newLogin.AccessToken, newLogin.Session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AuthenticateSession(ctx, newLogin.AccessToken); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("user Session revoke did not invalidate its token: %v", err)
	}

	adminLogin, err := service.Login(ctx, collection.Name, "alice@example.com", "alice-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.SetPassword(ctx, collection.ID, alice.ID, "alice-new-secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AuthenticateSession(ctx, adminLogin.AccessToken); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("admin password update did not revoke existing Sessions: %v", err)
	}
	adminSessions, err := service.ListUserSessions(ctx, collection.ID, alice.ID)
	if err != nil || len(adminSessions) != 1 || adminSessions[0].Status != "revoked" {
		t.Fatalf("Admin Session list did not retain its revoked state: sessions=%+v err=%v", adminSessions, err)
	}
}
