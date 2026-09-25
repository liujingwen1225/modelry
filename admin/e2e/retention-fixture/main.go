package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strconv"

	_ "modernc.org/sqlite"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) != 3 {
		return fmt.Errorf("usage: retention-fixture <database> <collection-id> <pruned-sequence>")
	}
	sequence, err := strconv.ParseInt(args[2], 10, 64)
	if err != nil || sequence < 1 {
		return fmt.Errorf("pruned sequence must be a positive integer")
	}
	database, err := sql.Open("sqlite", args[0])
	if err != nil {
		return fmt.Errorf("open Project database: %w", err)
	}
	defer database.Close()
	database.SetMaxOpenConns(1)

	transaction, err := database.BeginTx(context.Background(), nil)
	if err != nil {
		return fmt.Errorf("begin retention fixture transaction: %w", err)
	}
	defer transaction.Rollback()
	result, err := transaction.ExecContext(context.Background(), `DELETE FROM modelry_record_events WHERE collection_id = ? AND sequence <= ?`, args[1], sequence)
	if err != nil {
		return fmt.Errorf("prune fixture Events: %w", err)
	}
	deleted, err := result.RowsAffected()
	if err != nil || deleted == 0 {
		return fmt.Errorf("prune fixture Events: expected at least one deleted Event, got %d (%v)", deleted, err)
	}
	if _, err := transaction.ExecContext(context.Background(), `INSERT INTO modelry_record_event_watermarks (collection_id, pruned_sequence)
		VALUES (?, ?) ON CONFLICT(collection_id) DO UPDATE SET pruned_sequence = MAX(pruned_sequence, excluded.pruned_sequence)`, args[1], sequence); err != nil {
		return fmt.Errorf("set retention recovery watermark: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit retention fixture: %w", err)
	}
	return nil
}
