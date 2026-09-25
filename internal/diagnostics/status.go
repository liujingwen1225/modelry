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
}
