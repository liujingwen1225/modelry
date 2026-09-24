package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenUsesRealSQLiteAndDurableProjectIdentity(t *testing.T) {
	managed := filepath.Join(t.TempDir(), ".modelry")
	if err := os.MkdirAll(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	databasePath := filepath.Join(managed, "project.sqlite")
	store, err := Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	projectID := store.ProjectID()
	if len(projectID) < 12 || projectID[:4] != "prj_" {
		t.Fatalf("project ID is not an opaque stable identifier: %q", projectID)
	}
	if !sqliteVersionSupported(store.SQLiteVersion()) {
		t.Fatalf("bundled SQLite version %s is below the required minimum", store.SQLiteVersion())
	}
	settings, err := store.ConnectionSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(settings) != maxConnections {
		t.Fatalf("verified %d physical connections, want %d", len(settings), maxConnections)
	}
	for index, setting := range settings {
		if setting.ForeignKeys != 1 || setting.BusyTimeout != 5000 || setting.Synchronous != 2 || setting.JournalMode != "wal" {
			t.Fatalf("connection %d has unexpected pragmas: %#v", index+1, setting)
		}
	}
	readWhileRunning, err := ReadProjectID(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if readWhileRunning != projectID {
		t.Fatalf("status could not read project identity while Runtime storage is open: got %q, want %q", readWhileRunning, projectID)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if !store.IsClosed() {
		t.Fatal("SQLite store is still marked open after Close")
	}

	readProjectID, err := ReadProjectID(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if readProjectID != projectID {
		t.Fatalf("read-only status got project ID %q, want durable ID %q", readProjectID, projectID)
	}

	restarted, err := Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if restarted.ProjectID() != projectID {
		t.Fatalf("restart changed project ID from %q to %q", projectID, restarted.ProjectID())
	}
}

func TestTransactionBoundaryCommitsOrRollsBackWholeCallback(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if err := store.WithTransaction(context.Background(), func(tx Executor) error {
		_, err := tx.ExecContext(context.Background(), "CREATE TABLE transaction_boundary_test (value TEXT NOT NULL)")
		return err
	}); err != nil {
		t.Fatal(err)
	}

	rollback := errors.New("rollback this product operation")
	if err := store.WithTransaction(context.Background(), func(tx Executor) error {
		if _, err := tx.ExecContext(context.Background(), "INSERT INTO transaction_boundary_test (value) VALUES (?)", "must not persist"); err != nil {
			return err
		}
		return rollback
	}); !errors.Is(err, rollback) {
		t.Fatalf("WithTransaction error = %v, want callback error %v", err, rollback)
	}

	var count int
	if err := store.WithReadSnapshot(context.Background(), func(tx Executor) error {
		return tx.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM transaction_boundary_test").Scan(&count)
	}); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rolled-back operation left %d rows, want 0", count)
	}
}

func TestRejectsUnsupportedSQLiteVersion(t *testing.T) {
	for _, version := range []string{"3.51.2", "3.50.99", "2.99.99", "not-a-version"} {
		if sqliteVersionSupported(version) {
			t.Errorf("SQLite version %q should be rejected", version)
		}
	}
	for _, version := range []string{"3.51.3", "3.51.4", "3.52.0", "4.0.0"} {
		if !sqliteVersionSupported(version) {
			t.Errorf("SQLite version %q should be accepted", version)
		}
	}
}
