//go:build modelry_e2e

package runtime

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/liujingwen1225/modelry/internal/audit"
	"github.com/liujingwen1225/modelry/internal/automation"
	"github.com/liujingwen1225/modelry/internal/extensions"
	"github.com/liujingwen1225/modelry/internal/extensions/safehttp"
	"github.com/liujingwen1225/modelry/internal/storage"
)

const e2eWebhookAddress = "93.184.216.34:443"

func newAutomationService(ctx context.Context, store *storage.Store, extensionService *extensions.Service, auditService *audit.Service) (*automation.Service, error) {
	fixtureAddress := os.Getenv("MODELRY_E2E_WEBHOOK_FIXTURE_ADDR")
	caPath := os.Getenv("MODELRY_E2E_WEBHOOK_CA")
	if fixtureAddress == "" && caPath == "" {
		return automation.NewService(ctx, store, automation.ServiceOptions{Secrets: runtimeSecretProvider{service: extensionService}, Audits: auditService})
	}
	if fixtureAddress == "" || caPath == "" {
		return nil, errors.New("E2E Webhook fixture requires both local address and CA certificate")
	}
	fixtureAddress, err := validateE2EFixtureAddress(fixtureAddress)
	if err != nil {
		return nil, errors.New("E2E Webhook fixture address must be a localhost TCP listener")
	}
	info, err := os.Stat(caPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 64*1024 {
		return nil, errors.New("E2E Webhook fixture CA must be a regular PEM file no larger than 64 KiB")
	}
	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		return nil, errors.New("E2E Webhook fixture CA could not be read")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("E2E Webhook fixture CA is invalid")
	}
	tlsConfig := &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	client, err := safehttp.NewWebhookClientForE2E(e2eWebhookResolver{}, func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != e2eWebhookAddress {
			return nil, errors.New("E2E Webhook dial target did not match its pinned fixture address")
		}
		return (&net.Dialer{}).DialContext(ctx, network, fixtureAddress)
	}, tlsConfig)
	if err != nil {
		return nil, errors.New("E2E Webhook fixture transport could not be initialized")
	}
	retryDelay := time.Duration(0)
	if raw := os.Getenv("MODELRY_E2E_RETRY_DELAY_MS"); raw != "" {
		retryDelay, err = parseE2EWebhookRetryDelay(raw)
		if err != nil {
			return nil, errors.New("E2E Webhook retry delay must be between 1 and 2000 milliseconds")
		}
	}
	return automation.NewServiceForE2E(ctx, store, automation.ServiceOptions{Secrets: runtimeSecretProvider{service: extensionService}, Audits: auditService}, client, retryDelay)
}

func parseE2EWebhookRetryDelay(raw string) (time.Duration, error) {
	milliseconds, err := strconv.Atoi(raw)
	if err != nil || milliseconds < 1 || milliseconds > 2000 {
		return 0, errors.New("retry delay out of range")
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

type e2eWebhookResolver struct{}

func (e2eWebhookResolver) LookupNetIP(ctx context.Context, _ string, host string) ([]netip.Addr, error) {
	if strings.TrimSuffix(strings.ToLower(host), ".") != "hooks.modelry.test" {
		return nil, safehttp.ErrOriginNotAllowed
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
}

func validateE2EFixtureAddress(value string) (string, error) {
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return "", err
	}
	address, err := netip.ParseAddr(host)
	if err != nil || !address.IsLoopback() {
		return "", errors.New("fixture address is not loopback")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return "", errors.New("fixture port is invalid")
	}
	return net.JoinHostPort(address.String(), strconv.Itoa(port)), nil
}
