//go:build modelry_e2e

package automation

import (
	"context"
	"time"

	"github.com/liujingwen1225/modelry/internal/extensions/safehttp"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// NewServiceForE2E 为真实 Automation Service 注入固定 Fixture 发送端，此构造函数不会进入普通 Runtime 构建。
func NewServiceForE2E(ctx context.Context, store *storage.Store, options ServiceOptions, client *safehttp.WebhookClient, retryDelay time.Duration) (*Service, error) {
	service, err := newService(ctx, store, options, client)
	if err != nil {
		return nil, err
	}
	if retryDelay > 0 {
		for index := range service.retryDelays {
			service.retryDelays[index] = retryDelay
		}
	}
	return service, nil
}
