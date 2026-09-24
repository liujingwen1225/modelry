package serviceaccounts

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestServiceAccountAPIKeyLifecycleAndDelegationBoundary(t *testing.T) {
	ctx := context.Background()
	store, service := openService(t)
	defer store.Close()
	owner := audit.WithActor(ctx, audit.Actor{Kind: audit.ActorOwner, ID: "own_test"})

	created, err := service.Create(owner, CreateInput{Name: "Robot", Permission: PresetFullAccess})
	if err != nil || created.APIKeyReveal == nil || !created.APIKeyReveal.RevealedOnce {
		t.Fatalf("Create returned %+v, err = %v", created, err)
	}
	principal, grant, err := service.AuthenticateAPIKey(ctx, created.APIKeyReveal.Secret)
	if err != nil || principal.ID != created.ServiceAccount.ID || !grantAllows(grant, OperationRecordsRead) {
		t.Fatalf("AuthenticateAPIKey returned principal=%+v grant=%+v err=%v", principal, grant, err)
	}

	limited, err := service.Create(owner, CreateInput{
		Name: "Limited", Permission: PresetCustom, CustomPermissionVersion: CustomPermissionVersion,
		CustomOperations: []Operation{OperationServiceAccountsManage}, CreateAPIKey: boolPointer(false),
	})
	if err != nil {
		t.Fatal(err)
	}
	limitedActor := audit.WithActor(ctx, audit.Actor{Kind: audit.ActorServiceAccount, ID: limited.ServiceAccount.ID})
	_, err = service.Create(limitedActor, CreateInput{Name: "Escalated", Permission: PresetFullAccess, CreateAPIKey: boolPointer(false)})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("limited Service Account created a higher Permission target: %v", err)
	}
	_, err = service.Update(limitedActor, created.ServiceAccount.ID, UpdateInput{Name: stringPointer("Taken over")})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("limited Service Account updated a higher Permission target: %v", err)
	}

	if err := service.Disable(owner, created.ServiceAccount.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.AuthenticateAPIKey(ctx, created.APIKeyReveal.Secret); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("disabled Service Account key still authenticated: %v", err)
	}
	if err := service.Enable(owner, created.ServiceAccount.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.RevokeAPIKey(owner, created.APIKeyReveal.APIKey.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.AuthenticateAPIKey(ctx, created.APIKeyReveal.Secret); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("revoked API Key still authenticated: %v", err)
	}

	keys, err := service.ListAPIKeys(owner, created.ServiceAccount.ID)
	if err != nil || len(keys) != 1 || keys[0].Status != APIKeyRevoked || keys[0].ID != created.APIKeyReveal.APIKey.ID {
		t.Fatalf("ListAPIKeys returned %+v, err = %v", keys, err)
	}
	auditService, err := audit.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := auditService.List(ctx, audit.ListOptions{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries.Data) < 5 {
		t.Fatalf("expected durable account/key security events, got %d", len(entries.Data))
	}
	for _, entry := range entries.Data {
		if entry.Actor.ID != "own_test" {
			t.Fatalf("Audit event actor = %+v", entry.Actor)
		}
	}
}

func openService(t *testing.T) (*storage.Store, *Service) {
	t.Helper()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	audits, err := audit.NewService(context.Background(), store)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(context.Background(), store, audits)
	if err != nil {
		t.Fatal(err)
	}
	return store, service
}

func boolPointer(value bool) *bool { return &value }

func stringPointer(value string) *string { return &value }
