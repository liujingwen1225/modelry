//go:build modelry_e2e

package automation

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/extensions/safehttp"
	"github.com/liujingwen1225/modelry/internal/storage"
)

func TestDispatcherSendsOneSignedRequestWithPinnedFixtureAddress(t *testing.T) {
	requests := atomic.Int32{}
	bodySeen := make(chan []byte, 2)
	headerSeen := make(chan http.Header, 2)
	caCert, serverCert := webhookTestCertificate(t)
	serverKeyPair, err := tls.X509KeyPair(serverCert.certPEM, serverCert.keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		body, err := io.ReadAll(io.LimitReader(request.Body, (1<<20)+1))
		if err != nil {
			t.Errorf("read fixture request body: %v", err)
		}
		bodySeen <- body
		headerSeen <- request.Header.Clone()
		w.WriteHeader(http.StatusAccepted)
	})}
	go func() {
		_ = server.Serve(tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{serverKeyPair}}))
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	})
	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	resolver := e2eResolver(func(_ context.Context, _ string, host string) ([]netip.Addr, error) {
		if strings.TrimSuffix(host, ".") != "hooks.modelry.test" {
			return nil, fmt.Errorf("unmatched fixture host")
		}
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	})
	dialer := func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != "93.184.216.34:443" {
			return nil, fmt.Errorf("unmatched pinned fixture address")
		}
		return (&net.Dialer{}).DialContext(ctx, network, listener.Addr().String())
	}
	client, err := safehttp.NewWebhookClientForE2E(resolver, dialer, &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	service, store := newServiceFixture(t)
	_ = service.Close(ctx)
	service, err = NewServiceForE2E(ctx, store, ServiceOptions{Secrets: &testSecrets{
		metadata: map[string]testSecretMetadata{"sec_test": {Name: "signer", Configured: true}},
		values:   map[string][]byte{"sec_test": []byte("fixture-signing-key")},
	}}, client, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close(context.Background()) })
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "fixture", TargetURL: "https://hooks.modelry.test/events", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}
	id, err := newResourceID("dlv_")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{"deliveryId": id, "event": map[string]any{"type": "webhook.test", "testId": "test_1"}})
	if err != nil {
		t.Fatal(err)
	}
	eventDeliveryID, err := newResourceID("dlv_")
	if err != nil {
		t.Fatal(err)
	}
	eventID := "evt_Y29sX2ZpeHR1cmU_00000000000000000001"
	eventPayload, err := json.Marshal(map[string]any{"deliveryId": eventDeliveryID, "event": map[string]any{"id": eventID, "type": "record.created"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		if _, err := service.createDeliveryInTransaction(ctx, tx, deliveryIntent{id: id, sourceType: "test", sourceID: "test_1", webhookID: webhook.ID, eventType: "webhook.test", payload: payload, allowOff: true}); err != nil {
			return err
		}
		_, err := service.createDeliveryInTransaction(ctx, tx, deliveryIntent{id: eventDeliveryID, sourceType: "eventHook", sourceID: "hook_fixture", webhookID: webhook.ID, eventID: eventID, eventType: "record.created", payload: eventPayload})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	for _, deliveryID := range []string{id, eventDeliveryID} {
		deadline := time.After(4 * time.Second)
		for {
			var status string
			err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
				return snapshot.QueryRowContext(ctx, `SELECT status FROM modelry_automation_deliveries WHERE id=?`, deliveryID).Scan(&status)
			})
			if err != nil {
				t.Fatal(err)
			}
			if status == "succeeded" {
				break
			}
			if status == "failed" || status == "cancelled" {
				t.Fatalf("Delivery %s reached terminal status %q before success", deliveryID, status)
			}
			select {
			case <-deadline:
				t.Fatalf("Delivery %s status remained %q; requests=%d", deliveryID, status, requests.Load())
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	var testRequestBody, eventRequestBody []byte
	var testRequestHeaders, eventRequestHeaders http.Header
	for range 2 {
		requestBody := <-bodySeen
		requestHeaders := <-headerSeen
		if strings.Contains(string(requestBody), eventDeliveryID) {
			eventRequestBody, eventRequestHeaders = requestBody, requestHeaders
		} else {
			testRequestBody, testRequestHeaders = requestBody, requestHeaders
		}
	}
	if requests.Load() != 2 || !strings.Contains(string(testRequestBody), id) || !strings.Contains(string(eventRequestBody), eventDeliveryID) {
		t.Fatalf("fixture saw %d requests with bodies %s and %s", requests.Load(), testRequestBody, eventRequestBody)
	}
	if testRequestHeaders.Get("Idempotency-Key") != id || testRequestHeaders.Get("X-Modelry-Delivery-Id") != id || testRequestHeaders.Get("X-Modelry-Event-Id") != "" {
		t.Fatalf("synthetic test delivery headers = %v", testRequestHeaders)
	}
	if eventRequestHeaders.Get("Idempotency-Key") != eventDeliveryID || eventRequestHeaders.Get("X-Modelry-Delivery-Id") != eventDeliveryID || eventRequestHeaders.Get("X-Modelry-Event-Id") != eventID {
		t.Fatalf("Record Event delivery identity headers = %v", eventRequestHeaders)
	}
	parts := strings.Split(testRequestHeaders.Get("X-Modelry-Signature"), ",")
	if len(parts) != 2 || !strings.HasPrefix(parts[0], "t=") || !strings.HasPrefix(parts[1], "v1=") {
		t.Fatalf("signature format = %q", testRequestHeaders.Get("X-Modelry-Signature"))
	}
	mac := hmac.New(sha256.New, []byte("fixture-signing-key"))
	_, _ = mac.Write([]byte(strings.TrimPrefix(parts[0], "t=") + "."))
	_, _ = mac.Write(testRequestBody)
	if got, want := strings.TrimPrefix(parts[1], "v1="), hex.EncodeToString(mac.Sum(nil)); got != want {
		t.Fatalf("signature digest = %q, want %q", got, want)
	}
	if strings.Contains(string(testRequestBody), "fixture-signing-key") || strings.Contains(string(eventRequestBody), "fixture-signing-key") {
		t.Fatal("request body contains signing Secret")
	}
}

func TestUnavailableEncryptionKeyFailsBeforeDNSOrDial(t *testing.T) {
	var lookups, dials atomic.Int32
	resolver := e2eResolver(func(context.Context, string, string) ([]netip.Addr, error) {
		lookups.Add(1)
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	})
	dialer := func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, fmt.Errorf("dial should not run")
	}
	client, err := safehttp.NewWebhookClientForE2E(resolver, dialer, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	_, store := newServiceFixture(t)
	service, err := NewServiceForE2E(ctx, store, ServiceOptions{Secrets: unavailableKeySecrets{}}, client, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close(context.Background()) })
	webhook, err := service.CreateWebhook(ctx, WebhookInput{Name: "fixture", TargetURL: "https://hooks.modelry.test/events", SigningSecretID: "sec_test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.EnableWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}
	id, err := newResourceID("dlv_")
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"deliveryId": id, "event": map[string]any{"type": "webhook.test"}})
	if err := store.WithTransaction(ctx, func(tx storage.Executor) error {
		_, err := service.createDeliveryInTransaction(ctx, tx, deliveryIntent{id: id, sourceType: "test", sourceID: "test_2", webhookID: webhook.ID, eventType: "webhook.test", payload: payload, allowOff: true})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(2 * time.Second)
	for {
		var status, code string
		err := store.WithReadSnapshot(ctx, func(snapshot storage.Executor) error {
			return snapshot.QueryRowContext(ctx, `SELECT status,error_code FROM modelry_automation_deliveries WHERE id=?`, id).Scan(&status, &code)
		})
		if err != nil {
			t.Fatal(err)
		}
		if status == "failed" {
			if code != "secretKeyUnavailable" {
				t.Fatalf("key failure error code = %q", code)
			}
			break
		}
		select {
		case <-deadline:
			t.Fatalf("key failure did not finish; status=%q code=%q", status, code)
		case <-time.After(10 * time.Millisecond):
		}
	}
	if lookups.Load() != 0 || dials.Load() != 0 {
		t.Fatalf("unavailable key performed DNS/dial calls: lookups=%d dials=%d", lookups.Load(), dials.Load())
	}
}

type e2eResolver func(context.Context, string, string) ([]netip.Addr, error)

func (resolver e2eResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return resolver(ctx, network, host)
}

type unavailableKeySecrets struct{}

func (unavailableKeySecrets) SecretMetadata(context.Context, string) (string, bool, error) {
	return "signer", true, nil
}

func (unavailableKeySecrets) WithSecretValue(context.Context, string, func([]byte) error) error {
	return ErrSecretKeyUnavailable
}

type webhookCertificate struct {
	certPEM []byte
	keyPEM  []byte
}

func webhookTestCertificate(t *testing.T) (*x509.Certificate, webhookCertificate) {
	t.Helper()
	caPublic, caPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Modelry E2E Test CA"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, caPublic, caPrivate)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leafPublic, leafPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err = rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "hooks.modelry.test"}, DNSNames: []string{"hooks.modelry.test"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, ca, leafPublic, caPrivate)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(leafPrivate)
	if err != nil {
		t.Fatal(err)
	}
	return ca, webhookCertificate{certPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}), keyPEM: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})}
}
