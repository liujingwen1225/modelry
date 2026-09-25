//go:build modelry_e2e

package safehttp

import (
	"crypto/tls"
	"errors"
)

// NewWebhookClientForE2E 仅用于专用浏览器验收构建，仍会校验公网 IP 并固定目标地址。
func NewWebhookClientForE2E(resolver Resolver, dial DialContextFunc, roots *tls.Config) (*WebhookClient, error) {
	if resolver == nil || dial == nil {
		return nil, errors.New("E2E Webhook resolver and dialer are required")
	}
	return &WebhookClient{resolver: resolver, dial: dial, tls: roots}, nil
}
