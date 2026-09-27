//go:build !modelry_e2e

package runtime

import (
	"context"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/automation"
	"github.com/liujingwen1225/modelry/internal/extensions"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func newAutomationService(ctx context.Context, store *storage.Store, extensionService *extensions.Service, auditService *audit.Service) (*automation.Service, error) {
	return automation.NewService(ctx, store, automation.ServiceOptions{Secrets: runtimeSecretProvider{service: extensionService}, Audits: auditService})
}
