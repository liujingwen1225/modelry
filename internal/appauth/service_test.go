package appauth

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestAuthConfigurationHasSafeDefaultsAndDurablePendingLifecycle(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "project.sqlite")
	store := openAuthStore(t, databasePath)
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := records.New(store, models)
	if err != nil {
		t.Fatal(err)
	}
	users, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Members", Type: backendmodel.CollectionTypeAuth})
	if err != nil {
		t.Fatal(err)
	}
	posts, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Posts", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, models, profiles)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := service.GetConfiguration(ctx, users.ID)
	if err != nil {
		t.Fatal(err)
	}
	if initial.Version != 1 || initial.HasPending || initial.Applied != (AuthConfig{EmailPasswordEnabled: true, SelfRegistration: false, SessionDurationDays: 7, EmailVerification: EmailVerificationOff}) || initial.Pending != initial.Applied {
		t.Fatalf("Auth Collection did not receive required defaults: %+v", initial)
	}
	if _, err := service.GetConfiguration(ctx, posts.ID); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Normal Collection unexpectedly accepted Auth Configuration: %v", err)
	}

	changed := initial.Applied
	changed.SelfRegistration = true
	pending, err := service.SaveConfiguration(ctx, users.ID, AuthConfigSaveInput{ExpectedVersion: initial.Version, Configuration: changed})
	if err != nil || pending.Version != 2 || !pending.HasPending || pending.Applied.SelfRegistration || !pending.Pending.SelfRegistration {
		t.Fatalf("Save did not create an independent pending configuration: state=%+v err=%v", pending, err)
	}
	if _, err := service.ApplyConfiguration(ctx, users.ID, initial.Version); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale Apply should return conflict: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	restartedStore := openAuthStore(t, databasePath)
	restartedModels, err := backendmodel.NewService(ctx, restartedStore)
	if err != nil {
		t.Fatal(err)
	}
	restartedProfiles, err := records.New(restartedStore, restartedModels)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := NewService(ctx, restartedStore, restartedModels, restartedProfiles)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := restarted.GetConfiguration(ctx, users.ID)
	if err != nil || !reloaded.HasPending || reloaded.Version != pending.Version || !reloaded.Pending.SelfRegistration || reloaded.Applied.SelfRegistration {
		t.Fatalf("Auth Configuration was not durable across restart: state=%+v err=%v", reloaded, err)
	}
	applied, err := restarted.ApplyConfiguration(ctx, users.ID, reloaded.Version)
	if err != nil || applied.HasPending || applied.Version != 3 || !applied.Applied.SelfRegistration || applied.Pending != applied.Applied {
		t.Fatalf("Apply did not promote the pending configuration: state=%+v err=%v", applied, err)
	}

	disabled := applied.Applied
	disabled.EmailPasswordEnabled = false
	pending, err = restarted.SaveConfiguration(ctx, users.ID, AuthConfigSaveInput{ExpectedVersion: applied.Version, Configuration: disabled})
	if err != nil || !pending.HasPending {
		t.Fatalf("Save before Discard failed: state=%+v err=%v", pending, err)
	}
	discarded, err := restarted.DiscardConfiguration(ctx, users.ID, pending.Version)
	if err != nil || discarded.HasPending || discarded.Version != 5 || !discarded.Applied.EmailPasswordEnabled {
		t.Fatalf("Discard changed applied Auth Configuration: state=%+v err=%v", discarded, err)
	}
}

func TestCreateCollectionInitializesAuthConfigurationInSameTransaction(t *testing.T) {
	ctx := context.Background()
	store := openAuthStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	models, err := backendmodel.NewService(ctx, store)
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
	configuration := AuthConfig{EmailPasswordEnabled: true, SelfRegistration: true, SessionDurationDays: 14}
	collection, err := models.CreateCollectionWithInitializer(ctx, backendmodel.CreateCollectionInput{Name: "OpenMembers", Type: backendmodel.CollectionTypeAuth}, func(ctx context.Context, tx storage.Executor, collection backendmodel.Collection) error {
		return InitializeCollection(ctx, tx, collection, &configuration)
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err := service.GetConfiguration(ctx, collection.ID)
	if err != nil || state.HasPending || state.Version != 1 || state.Applied.EmailVerification != normalizeEmailVerification(configuration.EmailVerification) || state.Applied.EmailPasswordEnabled != configuration.EmailPasswordEnabled || state.Applied.SelfRegistration != configuration.SelfRegistration || state.Applied.SessionDurationDays != configuration.SessionDurationDays {
		t.Fatalf("create-time Auth Configuration was not applied atomically: state=%+v err=%v", state, err)
	}
	normal, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "NormalCollection", Type: backendmodel.CollectionTypeNormal})
	if err != nil {
		t.Fatal(err)
	}
	if err := InitializeCollection(ctx, nil, normal, &configuration); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Normal Collection accepted Auth Configuration: %v", err)
	}
}

func openAuthStore(t *testing.T, path string) *storage.Store {
	t.Helper()
	store, err := storage.Open(path)
	if err != nil {
		t.Fatalf("open real SQLite database: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}
