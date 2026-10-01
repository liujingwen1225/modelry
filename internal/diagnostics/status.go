package diagnostics

import "time"

type Health struct {
	State   string
	Message string
	Hint    string
}

type RuntimeStatus struct {
	State         string
	ObservedAt    time.Time
	Database      Health
	LocalStorage  Health
	ProjectSource string
	Version       string
}

type LocalStorageStatus struct {
	State    string
	Message  string
	Hint     string
	Provider string
	Path     string
}

type FileStorageStatus struct {
	State          string
	Provider       string
	ActiveProvider string
	Message        string
	Hint           string
}

type StorageStatus struct {
	Database     Health
	LocalStorage LocalStorageStatus
	FileStorage  FileStorageStatus
	// DatabaseSizeBytes 是 SQLite 主数据库当前占用的字节数；不可读时为 nil，
	// 让界面显示 Unavailable 而不是把失败呈现成 0。
	DatabaseSizeBytes *int64
}
