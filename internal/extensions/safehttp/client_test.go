package safehttp

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type resolverFunc func(context.Context, string, string) ([]netip.Addr, error)

func (f resolverFunc) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return f(ctx, network, host)
}

func testClient(t *testing.T, origins []string, resolver Resolver, dial DialContextFunc, root *x509.CertPool) *Client {
	t.Helper()
	client, err := newClient(origins, resolver, dial, &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: root})
	if err != nil {
		t.Fatalf("newClient() error = %v", err)
	}
	return client
}

func newTestTLSServer(t *testing.T, name string, handler http.Handler) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: name},
		DNSNames:              []string{name},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, key.Public(), key)
	if err != nil {
		t.Fatalf("CreateCertificate() error = %v", err)
	}
	privateKey, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("MarshalPKCS8PrivateKey() error = %v", err)
	}
	certificate, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateKey}),
	)
	if err != nil {
		t.Fatalf("X509KeyPair() error = %v", err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}}
	server.StartTLS()
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		server.Close()
		t.Fatalf("ParseCertificate() error = %v", err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	return server, roots
}

func TestNormalizeOrigin(t *testing.T) {
	tests := []struct {
		input string
		want  string
		valid bool
	}{
		{input: "https://api.example.test", want: "https://api.example.test", valid: true},
		{input: "HTTPS://API.EXAMPLE.TEST:443", want: "https://api.example.test", valid: true},
		{input: "https://api.example.test:8443", want: "https://api.example.test:8443", valid: true},
		{input: "https://api.example.test/", valid: false},
		{input: "https://api.example.test/path", valid: false},
		{input: "https://api.example.test?x=1", valid: false},
		{input: "https://api.example.test#fragment", valid: false},
		{input: "https://user:pass@api.example.test", valid: false},
		{input: "http://api.example.test", valid: false},
		{input: "https://*.example.test", valid: false},
		{input: "https://127.0.0.1", valid: false},
		{input: "https://[2606:4700:4700::1111]", valid: false},
		{input: "https://api_example.test", valid: false},
		{input: "https://api..example.test", valid: false},
		{input: "https://api.example.test:0443", valid: false},
		{input: "https://api.example.test:65536", valid: false},
		{input: "https://api.example.test:0", valid: false},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			got, err := NormalizeOrigin(test.input)
			if test.valid {
				if err != nil || got != test.want {
					t.Fatalf("NormalizeOrigin() = (%q, %v), want (%q, nil)", got, err, test.want)
				}
				return
			}
			if !errors.Is(err, ErrOriginNotAllowed) {
				t.Fatalf("NormalizeOrigin() error = %v, want ErrOriginNotAllowed", err)
			}
		})
	}
}

func TestNewLimitsOriginGrantsTo32(t *testing.T) {
	grants := make([]string, 0, maxOriginGrants+1)
	for i := 0; i < maxOriginGrants+1; i++ {
		grants = append(grants, "https://api-"+strconv.Itoa(i)+".example.test")
	}
	resolver := resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) { return nil, nil })
	dial := func(context.Context, string, string) (net.Conn, error) { return nil, nil }
	if _, err := newClient(grants[:maxOriginGrants], resolver, dial, nil); err != nil {
		t.Fatalf("newClient() with %d grants error = %v", maxOriginGrants, err)
	}
	if _, err := newClient(grants, resolver, dial, nil); !errors.Is(err, ErrOriginNotAllowed) {
		t.Fatalf("newClient() with %d grants error = %v, want ErrOriginNotAllowed", len(grants), err)
	}
}

func TestIsPublicUnicastAddress(t *testing.T) {
	tests := []struct {
		address string
		want    bool
	}{
		{address: "8.8.8.8", want: true},
		{address: "2001:4860:4860::8888", want: true},
		{address: "2606:4700:4700::1111", want: true},
		{address: "2a00::1", want: true},
		{address: "0.1.2.3"},
		{address: "10.0.0.1"},
		{address: "100.64.0.1"},
		{address: "127.0.0.1"},
		{address: "169.254.1.1"},
		{address: "172.16.0.1"},
		{address: "192.0.2.1"},
		{address: "192.168.1.1"},
		{address: "198.18.0.1"},
		{address: "198.51.100.1"},
		{address: "203.0.113.1"},
		{address: "224.0.0.1"},
		{address: "240.0.0.1"},
		{address: "::"},
		{address: "::1"},
		{address: "fc00::1"},
		{address: "fe80::1"},
		{address: "ff02::1"},
		{address: "2001:db8::1"},
		{address: "2002::1"},
		{address: "3fff::1"},
		{address: "2d00::1"},
		{address: "3000::1"},
		{address: "5f00::1"},
	}
	for _, test := range tests {
		t.Run(test.address, func(t *testing.T) {
			got := isPublicUnicast(netip.MustParseAddr(test.address))
			if got != test.want {
				t.Fatalf("isPublicUnicast(%s) = %t, want %t", test.address, got, test.want)
			}
		})
	}
}

func TestRequestUsesOnlyValidatedDNSAddressesAndFiltersResponse(t *testing.T) {
	var gotDial string
	var gotRequest *http.Request
	var mu sync.Mutex
	server, root := newTestTLSServer(t, "api.example.test", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotRequest = r.Clone(context.Background())
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", "etag-1")
		w.Header().Set("Set-Cookie", "secret=must-not-escape")
		w.Header().Set("X-Internal", "must-not-escape")
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, `{"ok":false}`)
	}))
	defer server.Close()

	resolver := resolverFunc(func(_ context.Context, network, host string) ([]netip.Addr, error) {
		if network != "ip" || host != "api.example.test." {
			t.Fatalf("unexpected lookup: network=%q host=%q", network, host)
		}
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	})
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		mu.Lock()
		gotDial = address
		mu.Unlock()
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	client := testClient(t, []string{"https://api.example.test"}, resolver, dial, root)
	response, err := client.Request(context.Background(), Request{
		Origin:  "https://api.example.test",
		Path:    "/v1/items?limit=1",
		Method:  http.MethodPost,
		Headers: map[string]string{"content-type": "application/json", "X-Api-Key": "key"},
		Body:    `{"name":"one"}`,
	})
	if err != nil {
		t.Fatalf("Request() error = %v", err)
	}
	if response.Status != http.StatusTeapot || response.Body != `{"ok":false}` {
		t.Fatalf("unexpected response: %#v", response)
	}
	if response.Headers["Content-Type"] != "application/json" || response.Headers["ETag"] != "etag-1" {
		t.Fatalf("allowed response headers missing: %#v", response.Headers)
	}
	if _, exists := response.Headers["Set-Cookie"]; exists {
		t.Fatalf("Set-Cookie escaped response allowlist: %#v", response.Headers)
	}
	if _, exists := response.Headers["X-Internal"]; exists {
		t.Fatalf("unknown response header escaped allowlist: %#v", response.Headers)
	}
	mu.Lock()
	if gotDial != "8.8.8.8:443" {
		t.Fatalf("dialed address %q, want checked IP and port", gotDial)
	}
	mu.Unlock()
	mu.Lock()
	requestCopy := gotRequest
	mu.Unlock()
	if requestCopy == nil || requestCopy.Host != "api.example.test" || requestCopy.URL.Path != "/v1/items" || requestCopy.URL.RawQuery != "limit=1" {
		t.Fatalf("unexpected outgoing request: %#v", requestCopy)
	}
}

func TestRequestRejectsEntireDNSSetWhenAnyAddressIsUnsafe(t *testing.T) {
	dialCalled := false
	lookups := 0
	client := testClient(t, []string{"https://api.example.test"}, resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		lookups++
		return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("10.0.0.5")}, nil
	}), func(context.Context, string, string) (net.Conn, error) {
		dialCalled = true
		return nil, errors.New("test dial should not run")
	}, nil)
	_, err := client.Request(context.Background(), Request{Origin: "https://api.example.test", Path: "/", Method: "GET"})
	if !errors.Is(err, ErrOriginNotAllowed) {
		t.Fatalf("Request() error = %v, want ErrOriginNotAllowed", err)
	}
	if dialCalled || lookups != 1 {
		t.Fatalf("dialCalled=%t lookups=%d, want false and 1", dialCalled, lookups)
	}
}

func TestRequestRejectsOriginPathHeadersAndBody(t *testing.T) {
	client := testClient(t, []string{"https://api.example.test"}, resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		t.Fatal("invalid request must be rejected before DNS")
		return nil, nil
	}), func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("invalid request must be rejected before dialing")
		return nil, nil
	}, nil)
	tests := []struct {
		name string
		req  Request
		want error
	}{
		{name: "ungranted origin", req: Request{Origin: "https://other.example.test", Path: "/", Method: "GET"}, want: ErrOriginNotAllowed},
		{name: "ungranted port", req: Request{Origin: "https://api.example.test:8443", Path: "/", Method: "GET"}, want: ErrOriginNotAllowed},
		{name: "path required", req: Request{Origin: "https://api.example.test", Path: "v1", Method: "GET"}, want: ErrExternalRequestFailed},
		{name: "double slash", req: Request{Origin: "https://api.example.test", Path: "//evil.test/path", Method: "GET"}, want: ErrExternalRequestFailed},
		{name: "fragment", req: Request{Origin: "https://api.example.test", Path: "/items#frag", Method: "GET"}, want: ErrExternalRequestFailed},
		{name: "backslash", req: Request{Origin: "https://api.example.test", Path: "/items\\next", Method: "GET"}, want: ErrExternalRequestFailed},
		{name: "encoded backslash", req: Request{Origin: "https://api.example.test", Path: "/items%5cnext", Method: "GET"}, want: ErrExternalRequestFailed},
		{name: "dot segment", req: Request{Origin: "https://api.example.test", Path: "/a/../b", Method: "GET"}, want: ErrExternalRequestFailed},
		{name: "encoded dot segment", req: Request{Origin: "https://api.example.test", Path: "/a/%2e%2e/b", Method: "GET"}, want: ErrExternalRequestFailed},
		{name: "nested encoded dot segment", req: Request{Origin: "https://api.example.test", Path: "/a/%252e%252e/b", Method: "GET"}, want: ErrExternalRequestFailed},
		{name: "invalid method", req: Request{Origin: "https://api.example.test", Path: "/", Method: "OPTIONS"}, want: ErrExternalRequestFailed},
		{name: "invalid header", req: Request{Origin: "https://api.example.test", Path: "/", Method: "GET", Headers: map[string]string{"X-Api-Key": "a\nb"}}, want: ErrExternalRequestFailed},
		{name: "oversized header", req: Request{Origin: "https://api.example.test", Path: "/", Method: "GET", Headers: map[string]string{"X-Api-Key": strings.Repeat("a", maxHeaderValueBytes+1)}}, want: ErrExternalRequestFailed},
		{name: "unknown header", req: Request{Origin: "https://api.example.test", Path: "/", Method: "GET", Headers: map[string]string{"Cookie": "x"}}, want: ErrExternalRequestFailed},
		{name: "duplicate canonical headers", req: Request{Origin: "https://api.example.test", Path: "/", Method: "GET", Headers: map[string]string{"X-Api-Key": "one", "x-api-key": "two"}}, want: ErrExternalRequestFailed},
		{name: "too many headers", req: Request{Origin: "https://api.example.test", Path: "/", Method: "GET", Headers: makeHeaders(17)}, want: ErrExternalRequestFailed},
		{name: "oversized body", req: Request{Origin: "https://api.example.test", Path: "/", Method: "POST", Body: strings.Repeat("a", maxRequestBodyBytes+1)}, want: ErrExternalRequestFailed},
		{name: "invalid UTF-8 body", req: Request{Origin: "https://api.example.test", Path: "/", Method: "POST", Body: string([]byte{0xff})}, want: ErrExternalRequestFailed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := client.Request(context.Background(), test.req)
			if !errors.Is(err, test.want) {
				t.Fatalf("Request() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestRequestDoesNotFollowRedirects(t *testing.T) {
	redirected := make(chan struct{}, 1)
	target, _ := newTestTLSServer(t, "api.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected <- struct{}{} }))
	defer target.Close()
	redirect, _ := newTestTLSServer(t, "api.example.test", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://other.example.test/", http.StatusFound)
	}))
	defer redirect.Close()
	root := x509.NewCertPool()
	for _, server := range []*httptest.Server{target, redirect} {
		certificate, err := x509.ParseCertificate(server.TLS.Certificates[0].Certificate[0])
		if err != nil {
			t.Fatalf("ParseCertificate() error = %v", err)
		}
		root.AddCert(certificate)
	}

	resolver := resolverFunc(func(_ context.Context, _ string, host string) ([]netip.Addr, error) {
		if host == "api.example.test." {
			return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
	})
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if strings.HasPrefix(address, "8.8.8.8:") {
			return (&net.Dialer{}).DialContext(ctx, network, redirect.Listener.Addr().String())
		}
		return (&net.Dialer{}).DialContext(ctx, network, target.Listener.Addr().String())
	}
	client := testClient(t, []string{"https://api.example.test"}, resolver, dial, root)
	_, err := client.Request(context.Background(), Request{Origin: "https://api.example.test", Path: "/", Method: "GET"})
	if !errors.Is(err, ErrExternalRequestFailed) {
		t.Fatalf("Request() error = %v, want ErrExternalRequestFailed", err)
	}
	select {
	case <-redirected:
		t.Fatal("client followed a redirect")
	default:
	}
}

func TestRequestLimitIsThreeCalls(t *testing.T) {
	server, root := newTestTLSServer(t, "api.example.test", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer server.Close()
	lookups := 0
	resolver := resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		lookups++
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	})
	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	client := testClient(t, []string{"https://api.example.test"}, resolver, dial, root)
	for i := 0; i < maxRequestsPerRun; i++ {
		if _, err := client.Request(context.Background(), Request{Origin: "https://api.example.test", Path: "/", Method: "GET"}); err != nil {
			t.Fatalf("request %d failed: %v", i+1, err)
		}
	}
	if _, err := client.Request(context.Background(), Request{Origin: "https://api.example.test", Path: "/", Method: "GET"}); !errors.Is(err, ErrExternalRequestFailed) {
		t.Fatalf("fourth Request() error = %v, want ErrExternalRequestFailed", err)
	}
	if lookups != maxRequestsPerRun {
		t.Fatalf("lookups=%d, want %d", lookups, maxRequestsPerRun)
	}
}

func TestRequestHasCancellableTwoSecondDeadline(t *testing.T) {
	started := make(chan struct{})
	server, root := newTestTLSServer(t, "api.example.test", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	client := testClient(t, []string{"https://api.example.test"}, resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}), func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}, root)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := client.Request(ctx, Request{Origin: "https://api.example.test", Path: "/", Method: "GET"})
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request never reached server")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, ErrExternalRequestFailed) {
			t.Fatalf("Request() error = %v, want generic external failure", err)
		}
	case <-time.After(time.Second):
		t.Fatal("request did not honor context cancellation")
	}
}

func TestRequestEnforcesTwoSecondDeadline(t *testing.T) {
	started := make(chan struct{})
	server, root := newTestTLSServer(t, "api.example.test", http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	client := testClient(t, []string{"https://api.example.test"}, resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}), func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}, root)
	start := time.Now()
	_, err := client.Request(context.Background(), Request{Origin: "https://api.example.test", Path: "/", Method: "GET"})
	elapsed := time.Since(start)
	select {
	case <-started:
	default:
		t.Fatal("request never reached server")
	}
	if !errors.Is(err, ErrExternalRequestFailed) {
		t.Fatalf("Request() error = %v, want generic external failure", err)
	}
	if elapsed < 1800*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("Request() elapsed = %s, want about 2 seconds", elapsed)
	}
}

func TestRequestRejectsOversizedResponseHeadersAndBody(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{name: "response header", handler: func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", strings.Repeat("a", maxHeaderValueBytes+1))
		}},
		{name: "response body", handler: func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, strings.Repeat("a", maxResponseBodyBytes+1))
		}},
		{name: "response header count", handler: func(w http.ResponseWriter, _ *http.Request) {
			for i := 0; i < 17; i++ {
				w.Header().Add("ETag", "etag")
			}
		}},
		{name: "non UTF-8 body", handler: func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte{0xff})
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server, root := newTestTLSServer(t, "api.example.test", test.handler)
			defer server.Close()
			client := testClient(t, []string{"https://api.example.test"}, resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
			}), func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
			}, root)
			_, err := client.Request(context.Background(), Request{Origin: "https://api.example.test", Path: "/", Method: "GET"})
			if !errors.Is(err, ErrExternalRequestFailed) {
				t.Fatalf("Request() error = %v, want ErrExternalRequestFailed", err)
			}
		})
	}
}

func makeHeaders(count int) map[string]string {
	headers := make(map[string]string, count)
	for i := 0; i < count; i++ {
		headers["header-"+strconv.Itoa(i)] = "value"
	}
	return headers
}
