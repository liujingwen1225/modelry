package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
)

// SnapshotTo 使用 SQLite VACUUM INTO 生成一致快照。
// 它与直接复制 project.sqlite 不同：快照包含已提交的 WAL 内容，并且在 Runtime 继续服务时保持一致。
func (store *Store) SnapshotTo(ctx context.Context, destination string) error {
	if store == nil || store.db == nil || store.IsClosed() {
		return errors.New("SQLite store is not open")
	}
	if strings.TrimSpace(destination) == "" {
		return errors.New("snapshot destination is required")
	}
	if _, err := os.Stat(destination); err == nil {
		return fmt.Errorf("snapshot destination %q already exists", destination)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	statement := "VACUUM INTO '" + strings.ReplaceAll(destination, "'", "''") + "'"
	if _, err := store.db.ExecContext(ctx, statement); err != nil {
		return fmt.Errorf("produce consistent SQLite snapshot: %w", err)
	}
	return nil
}

// RecordProjectionTables 返回当前存在的 Record 投影表名。
func (store *Store) RecordProjectionTables(ctx context.Context) ([]string, error) {
	if store == nil || store.db == nil || store.IsClosed() {
		return nil, errors.New("SQLite store is not open")
	}
	rows, err := store.db.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mry_records_%' ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list Record projection tables: %w", err)
	}
	defer rows.Close()
	tables := make([]string, 0, 8)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("list Record projection tables: %w", err)
		}
		tables = append(tables, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list Record projection tables: %w", err)
	}
	return tables, nil
}

// ProjectedRecordCount 统计全部 Record 投影表中的行数。
func (store *Store) ProjectedRecordCount(ctx context.Context) (int64, error) {
	tables, err := store.RecordProjectionTables(ctx)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, table := range tables {
		quoted, err := QuoteSQLiteIdentifier(table)
		if err != nil {
			return 0, err
		}
		var count int64
		if err := store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+quoted).Scan(&count); err != nil {
			return 0, fmt.Errorf("count Records in %s: %w", table, err)
		}
		total += count
	}
	return total, nil
}

// CollectionCount 统计 Applied Collection 数量。
func (store *Store) CollectionCount(ctx context.Context) (int64, error) {
	if store == nil || store.db == nil || store.IsClosed() {
		return 0, errors.New("SQLite store is not open")
	}
	var count int64
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM modelry_backend_collections`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count Applied Collections: %w", err)
	}
	return count, nil
}

// HasInternalMigrationTable 判断一个数据库文件是否是 Modelry 项目数据库。
func HasInternalMigrationTable(ctx context.Context, database *sql.DB) (bool, error) {
	var name string
	err := database.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'modelry_internal_migrations'`).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return name != "", nil
}

// DatabaseFormatVersion 返回项目数据库内部格式版本。
func DatabaseFormatVersion(ctx context.Context, database *sql.DB) (int, error) {
	var version sql.NullInt64
	if err := database.QueryRowContext(ctx, `SELECT MAX(version) FROM modelry_internal_migrations`).Scan(&version); err != nil {
		return 0, err
	}
	if !version.Valid {
		return 0, nil
	}
	return int(version.Int64), nil
}