package runtimesettings

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/liujingwen1225/modelry/internal/storage"
)

type recordedFact struct {
	Action, ResourceID, Result string
}

type recordingSink struct{ facts []recordedFact }

func (sink *recordingSink) AppendSettingsFactInTransaction(_ context.Context, _ storage.Executor, action, resourceID, result string) error {
	sink.facts = append(sink.facts, recordedFact{Action: action, ResourceID: resourceID, Result: result})
	return nil
}

func openSettingsStore(t *testing.T) *storage.Store {
	t.Helper()
	store, err := storage.Open(filepath.Join(t.TempDir(), "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestRuntimeSettingsReportSourceValidationAndRestartRequirement(t *testing.T) {
	ctx := context.Background()
	store := openSettingsStore(t)
	sink := &recordingSink{}
	service, err := NewService(ctx, store, Options{DefaultListenAddress: "127.0.0.1:8080", DefaultRequestRetentionDays: 30}, sink)
	if err != nil {
		t.Fatal(err)
	}
	service.SetRunningListen("127.0.0.1:8080")

	initial, err := service.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if initial.Revision != 1 || initial.ListenAddress.Source != SourceDefault || initial.ListenAddress.Value != "127.0.0.1:8080" ||
		initial.ListenAddress.RestartRequired || initial.RequestRetentionDays.Source != SourceDefault || initial.RequestRetentionDays.Value != "30" {
		t.Fatalf("initial settings = %+v", initial)
	}

	if _, err := service.Save(ctx, Input{ExpectedRevision: 1, ListenAddress: "127.0.0.1", RequestRetentionDays: 30}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("invalid listen address error = %v", err)
	}
	if _, err := service.Save(ctx, Input{ExpectedRevision: 1, ListenAddress: "127.0.0.1:8081", RequestRetentionDays: 4000}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("out of range retention error = %v", err)
	}

	saved, err := service.Save(ctx, Input{ExpectedRevision: 1, ListenAddress: "127.0.0.1:9090", RequestRetentionDays: 14})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 2 || saved.ListenAddress.Source != SourceProject || !saved.ListenAddress.RestartRequired || saved.RequestRetentionDays.RestartRequired {
		t.Fatalf("saved settings = %+v", saved)
	}
	if saved.RequestRetentionDaysValue() != 14 {
		t.Fatalf("retention value = %d", saved.RequestRetentionDaysValue())
	}
	if _, err := service.Save(ctx, Input{ExpectedRevision: 1, ListenAddress: "127.0.0.1:9091", RequestRetentionDays: 14}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision error = %v, want ErrConflict", err)
	}
	if len(sink.facts) != 1 || sink.facts[0].Action != "runtimeSettings.updated" {
		t.Fatalf("audit facts = %+v", sink.facts)
	}

	// 显式 flag 覆盖 Project 取值，并且因为进程已在使用它而不需要重启。
	flagged, err := NewService(ctx, store, Options{
		DefaultListenAddress: "127.0.0.1:8080", FlagListenAddress: "127.0.0.1:7070", DefaultRequestRetentionDays: 30,
	}, sink)
	if err != nil {
		t.Fatal(err)
	}
	flagged.SetRunningListen("127.0.0.1:7070")
	view, err := flagged.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if view.ListenAddress.Value != "127.0.0.1:7070" || view.ListenAddress.Source != SourceFlag || view.ListenAddress.RestartRequired {
		t.Fatalf("flag precedence = %+v", view.ListenAddress)
	}
	// flag 生效时保存仍然写入 Project 值，但报告继续显示 flag。
	updated, err := flagged.Save(ctx, Input{ExpectedRevision: 2, ListenAddress: "127.0.0.1:6060", RequestRetentionDays: 7})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ListenAddress.Source != SourceFlag || updated.ListenAddress.Value != "127.0.0.1:7070" {
		t.Fatalf("flag source must win after save: %+v", updated.ListenAddress)
	}
	if updated.RequestRetentionDays.Value != "7" || updated.RequestRetentionDays.Source != SourceProject {
		t.Fatalf("retention after save = %+v", updated.RequestRetentionDays)
	}
}