package mail

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liujingwen1225/modelry/internal/storage"
)

type fakeSecrets struct{ values map[string]string }

func (secrets fakeSecrets) SecretMetadata(_ context.Context, secretID string) (string, bool, error) {
	value, exists := secrets.values[secretID]
	if !exists || value == "" {
		return "", false, ErrCredentialUnavailable
	}
	return secretID, true, nil
}

func (secrets fakeSecrets) WithSecretValue(ctx context.Context, secretID string, use func([]byte) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	value, exists := secrets.values[secretID]
	if !exists || value == "" {
		return ErrCredentialUnavailable
	}
	return use([]byte(value))
}

type fakeSender struct {
	mu      sync.Mutex
	sent    []Message
	failure error
}

func (sender *fakeSender) Send(_ context.Context, _ Config, _ Credentials, message Message) error {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	if sender.failure != nil {
		return sender.failure
	}
	sender.sent = append(sender.sent, message)
	return nil
}

func (sender *fakeSender) messages() []Message {
	sender.mu.Lock()
	defer sender.mu.Unlock()
	return append([]Message(nil), sender.sent...)
}

type fakePayloads struct {
	subject string
	body   string
	fail   error
}

func (payloads fakePayloads) RenderDeliveryPayload(context.Context, DeliveryKind, string, string) (string, string, error) {
	if payloads.fail != nil {
		return "", "", payloads.fail
	}
	return payloads.subject, payloads.body, nil
}

type mailFixture struct {
	service    *Service
	sender     *fakeSender
	secrets    fakeSecrets
	payloads   fakePayloads
	database   string
	store      *storage.Store
}

func newMailFixture(t *testing.T, payloads fakePayloads) mailFixture {
	t.Helper()
	root := t.TempDir()
	database := filepath.Join(root, "project.sqlite")
	store, err := storage.Open(database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	sender := &fakeSender{}
	secrets := fakeSecrets{values: map[string]string{"sec_user": "smtp-user", "sec_pass": "smtp-password-marker"}}
	service, err := NewService(context.Background(), ServiceOptions{
		Store: store, Secrets: secrets, Payloads: payloads, Sender: sender,
		Now: func() time.Time { return time.Unix(1_800_000_000, 0).UTC() },
	})
	if err != nil {
		t.Fatal(err)
	}
	return mailFixture{service: service, sender: sender, secrets: secrets, payloads: payloads, database: database, store: store}
}

func (fixture mailFixture) enable(t *testing.T) Config {
	t.Helper()
	config, err := fixture.service.SaveConfig(context.Background(), 1, Config{
		Enabled: true, Host: "smtp.example.test", Port: 587, Security: SecurityStartTLS,
		FromAddress: "modelry@example.test", FromName: "Modelry",
		UsernameSecretID: "sec_user", PasswordSecretID: "sec_pass",
	})
	if err != nil {
		t.Fatal(err)
	}
	return config
}
func TestEnablingMailRequiresCredentials(t *testing.T) {
	fixture := newMailFixture(t, fakePayloads{subject: "s", body: "b"})
	if _, err := fixture.service.SaveConfig(context.Background(), 1, Config{Enabled: true, Host: "smtp.example.test", Port: 587, FromAddress: "modelry@example.test"}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("enabling without credentials error = %v, want ErrNotConfigured", err)
	}
	if _, err := fixture.service.SaveConfig(context.Background(), 1, Config{Enabled: true, Host: "", Port: 0, FromAddress: "nope"}); !errors.Is(err, ErrInvalidArgument) && !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("invalid sender error = %v", err)
	}
	if _, err := fixture.service.EnqueueStandalone(context.Background(), KindVerification, "not-an-address", "token"); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("invalid recipient error = %v", err)
	}
}

func TestOutboxDeliversAndKeepsSafeHistory(t *testing.T) {
	fixture := newMailFixture(t, fakePayloads{subject: "Verify your address", body: "token=rst_secret_marker"})
	fixture.enable(t)
	delivery, err := fixture.service.EnqueueStandalone(context.Background(), KindPasswordReset, "user@example.test", "tok_1")
	if err != nil {
		t.Fatal(err)
	}
	processed, err := fixture.service.processNext(context.Background())
	if err != nil || !processed {
		t.Fatalf("processNext = %v, %v", processed, err)
	}
	messages := fixture.sender.messages()
	if len(messages) != 1 || !strings.Contains(messages[0].Body, "rst_secret_marker") {
		t.Fatalf("sent messages = %+v", messages)
	}
	stored, err := fixture.service.Delivery(context.Background(), delivery.ID)
	if err != nil || stored.Status != DeliverySucceeded || stored.Attempts != 1 {
		t.Fatalf("stored delivery = %+v err=%v", stored, err)
	}
	history, err := fixture.service.ListDeliveries(context.Background(), 10)
	if err != nil || len(history) != 1 {
		t.Fatalf("history = %+v err=%v", history, err)
	}
	contents, err := os.ReadFile(fixture.database)
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"rst_secret_marker", "smtp-password-marker", "smtp-user"} {
		if strings.Contains(string(contents), marker) {
			t.Fatalf("Project database persisted %q", marker)
		}
	}
}

func TestOutboxKeepsPendingWhileProviderIsDisabled(t *testing.T) {
	fixture := newMailFixture(t, fakePayloads{subject: "s", body: "b"})
	delivery, err := fixture.service.EnqueueStandalone(context.Background(), KindVerification, "user@example.test", "tok_1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.processNext(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored, err := fixture.service.Delivery(context.Background(), delivery.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != DeliveryPending || stored.ErrorCode != ErrorProviderDisabled || stored.Attempts != 0 {
		t.Fatalf("disabled provider delivery = %+v", stored)
	}
	if len(fixture.sender.messages()) != 0 {
		t.Fatal("disabled provider must not send")
	}
}

func TestOutboxExhaustsBoundedAttempts(t *testing.T) {
	fixture := newMailFixture(t, fakePayloads{subject: "s", body: "b"})
	fixture.enable(t)
	fixture.sender.failure = ErrUnavailable
	delivery, err := fixture.service.EnqueueStandalone(context.Background(), KindVerification, "user@example.test", "tok_1")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0).UTC()
	for attempt := 0; attempt < MaximumAttemptsPerDelivery; attempt++ {
		if _, err := fixture.service.processNext(context.Background()); err != nil {
			t.Fatal(err)
		}
		// 让下一次尝试立即可用。
		if err := fixture.store.WithTransaction(context.Background(), func(tx storage.Executor) error {
			_, err := tx.ExecContext(context.Background(), "UPDATE modelry_mail_deliveries SET next_attempt_at = ? WHERE id = ?", now.Unix()-1, delivery.ID)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	stored, err := fixture.service.Delivery(context.Background(), delivery.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != DeliveryFailed || stored.ErrorCode != ErrorAttemptExhausted || stored.Attempts != MaximumAttemptsPerDelivery {
		t.Fatalf("exhausted delivery = %+v", stored)
	}
	if _, err := fixture.service.RetryDelivery(context.Background(), delivery.ID); err != nil {
		t.Fatalf("retry failed delivery: %v", err)
	}
	fixture.sender.failure = nil
	if _, err := fixture.service.processNext(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored, err = fixture.service.Delivery(context.Background(), delivery.ID)
	if err != nil || stored.Status != DeliverySucceeded {
		t.Fatalf("retried delivery = %+v err=%v", stored, err)
	}
}

func TestRestartReturnsRunningDeliveriesToPending(t *testing.T) {
	fixture := newMailFixture(t, fakePayloads{subject: "s", body: "b"})
	delivery, err := fixture.service.EnqueueStandalone(context.Background(), KindVerification, "user@example.test", "tok_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.WithTransaction(context.Background(), func(tx storage.Executor) error {
		_, err := tx.ExecContext(context.Background(), "UPDATE modelry_mail_deliveries SET status = ? WHERE id = ?", string(DeliveryRunning), delivery.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewService(context.Background(), ServiceOptions{
		Store: fixture.store, Secrets: fixture.secrets, Payloads: fixture.payloads, Sender: fixture.sender,
	})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := restarted.Delivery(context.Background(), delivery.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 重启后归还 pending，并保留 interrupted 标记供 UI 说明恢复原因。
	if stored.Status != DeliveryPending || stored.ErrorCode != ErrorInterrupted {
		t.Fatalf("restarted delivery = %+v", stored)
	}
}

func TestPlaintextMailTransportStaysLoopbackOnly(t *testing.T) {
	fixture := newMailFixture(t, fakePayloads{subject: "s", body: "b"})
	base := Config{
		Enabled: true, Port: 1025, Security: SecurityPlaintext,
		FromAddress: "modelry@example.test", FromName: "Modelry",
		UsernameSecretID: "sec_user", PasswordSecretID: "sec_pass",
	}
	remote := base
	remote.Host = "smtp.example.test"
	if _, err := fixture.service.SaveConfig(context.Background(), 1, remote); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("plaintext remote host error = %v, want ErrInvalidArgument", err)
	}
	local := base
	local.Host = "127.0.0.1"
	saved, err := fixture.service.SaveConfig(context.Background(), 1, local)
	if err != nil {
		t.Fatalf("plaintext loopback host error = %v", err)
	}
	if saved.Security != SecurityPlaintext {
		t.Fatalf("saved security = %q, want plaintext", saved.Security)
	}
	if err := (SMTPSender{}).Send(context.Background(), remote, Credentials{}, Message{}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("plaintext remote send error = %v, want ErrInvalidArgument", err)
	}
	if !isLoopbackHost("localhost") || !isLoopbackHost("::1") || !isLoopbackHost("[::1]") || !isLoopbackHost("127.0.0.1") {
		t.Fatal("loopback hosts must be recognized")
	}
	if isLoopbackHost("10.0.0.5") || isLoopbackHost("smtp.example.test") {
		t.Fatal("remote hosts must not be treated as loopback")
	}
}

func TestTestDeliveryUsesBuiltInPayload(t *testing.T) {
	fixture := newMailFixture(t, fakePayloads{fail: errors.New("the recovery payload source must not render test deliveries")})
	fixture.enable(t)
	delivery, err := fixture.service.SendTest(context.Background(), "owner@example.test")
	if err != nil {
		t.Fatalf("SendTest error = %v", err)
	}
	if delivery.Status != DeliverySucceeded {
		t.Fatalf("test delivery status = %q, error = %q", delivery.Status, delivery.ErrorCode)
	}
	messages := fixture.sender.messages()
	if len(messages) != 1 || messages[0].Subject != "Modelry test message" || messages[0].To != "owner@example.test" {
		t.Fatalf("test delivery messages = %+v", messages)
	}
}