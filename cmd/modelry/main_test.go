package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestStatusJSONShowsDurableProjectIdentityWhileRuntimeIsOpen(t *testing.T) {
	root := t.TempDir()
	managed := filepath.Join(root, ".modelry")
	if err := os.MkdirAll(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := storage.Open(filepath.Join(managed, "project.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := run([]string{"status", "--project-root", root, "--json"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("status exit code = %d, stderr = %s", code, stderr.String())
	}
	var output statusRecord
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("status did not print JSON: %v (%s)", err, stdout.String())
	}
	if output.ProjectID != store.ProjectID() || output.State != "initialized" {
		t.Fatalf("status did not report durable project state: got %#v, want ID %q", output, store.ProjectID())
	}
	if output.ProjectSource != "flag" || output.DatabaseState != "ready" {
		t.Fatalf("status fields did not reflect the selected project root: %#v", output)
	}
}

func TestVersionCommandReportsBuildVersion(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := run([]string{"version"}, &stdout, &stderr)
	if code != 0 || stdout.String() != "modelry dev\n" {
		t.Fatalf("version output = %d, %q (stderr %q)", code, stdout.String(), stderr.String())
	}
}

func TestStartPrintsActualBoundAddressOnlyAfterReady(t *testing.T) {
	root := t.TempDir()
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	reader, writer := io.Pipe()
	var stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runStartContext(ctx, []string{"--project-root", root, "--listen", "127.0.0.1:0"}, writer, &stderr, workingDirectory)
	}()
	defer func() {
		cancel()
		_ = reader.Close()
		_ = writer.Close()
	}()
	lineResult := make(chan struct {
		line string
		err  error
	}, 1)
	go func() {
		line, err := bufio.NewReader(reader).ReadString('\n')
		lineResult <- struct {
			line string
			err  error
		}{line: line, err: err}
	}()
	var line string
	select {
	case result := <-lineResult:
		if result.err != nil {
			t.Fatalf("start did not print READY: %v", result.err)
		}
		line = result.line
	case <-time.After(5 * time.Second):
		t.Fatal("start did not print READY within 5 seconds")
	}
	if !strings.HasPrefix(line, "READY ") {
		t.Fatalf("start output is not a machine-readable READY event: %q", line)
	}
	var ready readyRecord
	if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "READY "))), &ready); err != nil {
		t.Fatalf("cannot parse READY event: %v (%q)", err, line)
	}
	if ready.State != "ready" || ready.Address == "" || strings.HasSuffix(ready.Address, ":0") || !strings.HasPrefix(ready.URL, "http://127.0.0.1:") || !strings.HasPrefix(ready.ProjectID, "prj_") {
		t.Fatalf("READY event did not report the actual bound listener and project: %#v", ready)
	}
	response, err := (&http.Client{Timeout: 3 * time.Second}).Get(ready.URL + "/admin/api/v1/runtime/status")
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil {
		t.Fatal(readErr)
	}
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"state":"ready"`) {
		t.Fatalf("READY was printed before Runtime HTTP was ready: status=%d body=%s", response.StatusCode, body)
	}
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("start exited with code %d: %s", code, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("start did not gracefully stop after cancellation")
	}
}
