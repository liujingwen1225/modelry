package safehttp

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func webhookTestClient(t *testing.T, resolver Resolver, dial DialContextFunc, roots *x509.CertPool) *WebhookClient {
	t.Helper()
	return &WebhookClient{resolver: resolver, dial: dial, tls: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}}
}

func TestWebhookClientSendsLargeSignedBodyInOneRequestAndDoesNotReadResponseBody(t *testing.T) {
	body := strings.Repeat("payload-", 18*1024)
	requests := 0
	server, roots := newTestTLSServer(t, "hooks.modelry.test", http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path != "/v1/events" || request.Method != http.MethodPost {
			t.Errorf("request target = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Idempotency-Key") != "dlv_test" || request.Header.Get("X-Modelry-Delivery-Id") != "dlv_test" {
			t.Errorf("signed delivery headers were not forwarded: %v", request.Header)
		}
		data, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		if string(data) != body {
			t.Errorf("request body length=%d, want %d", len(data), len(body))
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, "response body is ignored")
	}))
	defer server.Close()
	client := webhookTestClient(t, resolverFunc(func(_ context.Context, _, host string) ([]netip.Addr, error) {
		if host != "hooks.modelry.test." {
			t.Fatalf("resolver received host %q", host)
		}
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}), func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}, roots)
	target, err := client.PrepareWebhook(context.Background(), "https://hooks.modelry.test/v1/events")
	if err != nil {
		t.Fatalf("PrepareWebhook() error = %v", err)
	}
	status, err := target.Post(context.Background(), []byte(body), http.Header{
		"Content-Type":          []string{"application/json"},
		"Idempotency-Key":       []string{"dlv_test"},
		"X-Modelry-Delivery-Id": []string{"dlv_test"},
		"X-Modelry-Signature":   []string{"t=1790337600,v1=" + strings.Repeat("a", 64)},
	})
	if err != nil || status != http.StatusAccepted || requests != 1 {
		t.Fatalf("Post() = status %d, err %v, requests %d; want 202, nil, 1", status, err, requests)
	}
}

func TestWebhookClientRejectsUnsafeAddressBeforeDial(t *testing.T) {
	dials := 0
	client := &WebhookClient{resolver: resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}),
		dial: func(context.Context, string, string) (net.Conn, error) {
			dials++
			return nil, nil
		},
	}
	if _, err := client.PrepareWebhook(context.Background(), "https://hooks.modelry.test/v1/events"); err != ErrOriginNotAllowed {
		t.Fatalf("PrepareWebhook() error = %v, want ErrOriginNotAllowed", err)
	}
	if dials != 0 {
		t.Fatalf("unsafe destination caused %d dial attempts", dials)
	}
}

func TestWebhookRequestCanBeCancelled(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server, roots := newTestTLSServer(t, "hooks.modelry.test", http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(started)
		select {
		case <-request.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	client := webhookTestClient(t, resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}), func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}, roots)
	target, err := client.PrepareWebhook(context.Background(), "https://hooks.modelry.test/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := target.Post(ctx, []byte(`{"ok":true}`), http.Header{
			"Content-Type": []string{"application/json"}, "Idempotency-Key": []string{"dlv_test"},
			"X-Modelry-Delivery-Id": []string{"dlv_test"}, "X-Modelry-Signature": []string{"t=1790337600,v1=" + strings.Repeat("a", 64)},
		})
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("server did not receive the request")
	}
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("cancelled request unexpectedly succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not end the outbound request")
	}
}
