package appauth

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/backendmodel"
	"github.com/liujingwen1225/modelry/internal/records"
	"github.com/liujingwen1225/modelry/internal/storage"
)

// fakeCipher 只做可逆标记，用于验证 Recovery token 的 at-rest 边界，不参与生产加密。
type fakeCipher struct{}

func (fakeCipher) EncryptProjectValue(_ context.Context, _ storage.Executor, contextID string, plaintext []byte) ([]byte, error) {
	return append([]byte(contextID+":"), plaintext...), nil
}

func (fakeCipher) DecryptProjectValue(_ context.Context, contextID string, ciphertext []byte) ([]byte, error) {
	prefix := contextID + ":"
	if !strings.HasPrefix(string(ciphertext), prefix) {
		return nil, errors.New("ciphertext does not belong to this context")
	}
	return ciphertext[len(prefix):], nil
}

type recordedMail struct {
	Kind      string
	Recipient string
	PayloadRef string
}

type fakeMailEnqueuer struct {
	configured bool
	recorded   []recordedMail
}

func (enqueuer *fakeMailEnqueuer) EnqueueRecoveryMail(_ context.Context, _ storage.Executor, kind string, recipient, payloadRef string) error {
	enqueuer.recorded = append(enqueuer.recorded, recordedMail{Kind: kind, Recipient: recipient, PayloadRef: payloadRef})
	return nil
}

func (enqueuer *fakeMailEnqueuer) MailConfigured(context.Context) (bool, error) { return enqueuer.configured, nil }

type fakeAuthAudit struct{ actions []string }

func (sink *fakeAuthAudit) AppendAuthFactInTransaction(_ context.Context, _ storage.Executor, _, _ string, action, _, _ string) error {
	sink.actions = append(sink.actions, action)
	return nil
}

type recoveryFixture struct {
	service *Service
	mail    *fakeMailEnqueuer
	audit   *fakeAuthAudit
	users   backendmodel.Collection
}

func newRecoveryFixture(t *testing.T, config AuthConfig) recoveryFixture {
	t.Helper()
	ctx := context.Background()
	store := openAuthStore(t, filepath.Join(t.TempDir(), "project.sqlite"))
	models, err := backendmodel.NewService(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := records.New(store, models)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, store, models, profiles)
	if err != nil {
		t.Fatal(err)
	}
	users, err := models.CreateCollection(ctx, backendmodel.CreateCollectionInput{Name: "Members", Type: backendmodel.CollectionTypeAuth})
	if err != nil {
		t.Fatal(err)
	}
	if err := InitializeCollection(ctx, nil, users, nil); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("InitializeCollection without transaction error = %v", err)
	}
	state, err := service.GetConfiguration(ctx, users.ID)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := service.SaveConfiguration(ctx, users.ID, AuthConfigSaveInput{ExpectedVersion: state.Version, Configuration: config})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ApplyConfiguration(ctx, users.ID, saved.Version); err != nil {
		t.Fatalf("apply Auth Configuration: %v", err)
	}
	mail := &fakeMailEnqueuer{configured: true}
	audit := &fakeAuthAudit{}
	service.SetRecoveryDependencies(mail, fakeCipher{}, audit)
	return recoveryFixture{service: service, mail: mail, audit: audit, users: users}
}

func (fixture recoveryFixture) codeFromMail(t *testing.T) string {
	t.Helper()
	if len(fixture.mail.recorded) == 0 {
		t.Fatal("no Mail Delivery intent was recorded")
	}
	last := fixture.mail.recorded[len(fixture.mail.recorded)-1]
	subject, body, err := fixture.service.RenderDeliveryPayload(context.Background(), last.Kind, last.PayloadRef, last.Recipient)
	if err != nil {
		t.Fatalf("render Recovery payload: %v", err)
	}
	if subject == "" || !strings.Contains(body, "single-use code") {
		t.Fatalf("unexpected Recovery message: %q %q", subject, body)
	}
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "rst_") || strings.HasPrefix(trimmed, "vfy_") {
			return trimmed
		}
	}
	t.Fatalf("Recovery message did not contain a code: %q", body)
	return ""
}

var _ = fmt.Sprintf
func TestPasswordResetConsumesCodeAndRevokesSessions(t *testing.T) {
	ctx := context.Background()
	fixture := newRecoveryFixture(t, AuthConfig{EmailPasswordEnabled: true, SelfRegistration: true, SessionDurationDays: 7, EmailVerification: EmailVerificationOff})
	if _, err := fixture.service.Register(ctx, "Members", map[string]any{"email": "user@example.test"}, "original-password"); err != nil {
		t.Fatalf("register App User: %v", err)
	}
	login, err := fixture.service.Login(ctx, "Members", "user@example.test", "original-password")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if err := fixture.service.RequestPasswordReset(ctx, "Members", "user@example.test", "http://127.0.0.1:8080"); err != nil {
		t.Fatalf("request password reset: %v", err)
	}
	code := fixture.codeFromMail(t)
	if !strings.HasPrefix(code, "rst_") {
		t.Fatalf("password reset code = %q", code)
	}
	if err := fixture.service.ConfirmPasswordReset(ctx, "Members", "rst_"+strings.Repeat("0", 32), "replacement-password"); !errors.Is(err, ErrRecoveryTokenInvalid) {
		t.Fatalf("unknown code error = %v, want ErrRecoveryTokenInvalid", err)
	}
	if err := fixture.service.ConfirmPasswordReset(ctx, "Members", code, "replacement-password"); err != nil {
		t.Fatalf("confirm password reset: %v", err)
	}
	if _, err := fixture.service.Login(ctx, "Members", "user@example.test", "original-password"); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("login with the old password error = %v", err)
	}
	if _, err := fixture.service.Login(ctx, "Members", "user@example.test", "replacement-password"); err != nil {
		t.Fatalf("login with the new password: %v", err)
	}
	if _, err := fixture.service.GetSession(ctx, "Members", login.AccessToken); err == nil {
		t.Fatal("password reset must revoke existing Application sessions")
	}
	if err := fixture.service.ConfirmPasswordReset(ctx, "Members", code, "third-password"); !errors.Is(err, ErrRecoveryTokenInvalid) {
		t.Fatalf("replayed code error = %v, want ErrRecoveryTokenInvalid", err)
	}
	found := false
	for _, action := range fixture.audit.actions {
		if action == "auth.passwordResetCompleted" {
			found = true
		}
	}
	if !found {
		t.Fatalf("audit actions = %v", fixture.audit.actions)
	}
}

func TestEmailVerificationRequiredBlocksLoginUntilConfirmed(t *testing.T) {
	ctx := context.Background()
	fixture := newRecoveryFixture(t, AuthConfig{EmailPasswordEnabled: true, SelfRegistration: true, SessionDurationDays: 7, EmailVerification: EmailVerificationRequired})
	if _, err := fixture.service.RegisterWithOrigin(ctx, "Members", map[string]any{"email": "verify@example.test"}, "verification-password", "https://modelry.example.test"); err != nil {
		t.Fatalf("register with required verification: %v", err)
	}
	if _, err := fixture.service.Login(ctx, "Members", "verify@example.test", "verification-password"); !errors.Is(err, ErrEmailNotVerified) {
		t.Fatalf("unverified login error = %v, want ErrEmailNotVerified", err)
	}
	if len(fixture.mail.recorded) != 1 || fixture.mail.recorded[0].Kind != "verification" {
		t.Fatalf("verification mail intents = %+v", fixture.mail.recorded)
	}
	code := fixture.codeFromMail(t)
	if !strings.HasPrefix(code, "vfy_") {
		t.Fatalf("verification code = %q", code)
	}
	if err := fixture.service.ConfirmEmailVerification(ctx, "Members", code); err != nil {
		t.Fatalf("confirm email verification: %v", err)
	}
	if _, err := fixture.service.Login(ctx, "Members", "verify@example.test", "verification-password"); err != nil {
		t.Fatalf("login after verification: %v", err)
	}
}

func TestRecoveryRequestsAreNotEnumerableAndFailClosedWithoutMail(t *testing.T) {
	ctx := context.Background()
	fixture := newRecoveryFixture(t, AuthConfig{EmailPasswordEnabled: true, SelfRegistration: true, SessionDurationDays: 7, EmailVerification: EmailVerificationOptional})
	if _, err := fixture.service.Register(ctx, "Members", map[string]any{"email": "known@example.test"}, "known-password"); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.RequestPasswordReset(ctx, "Members", "unknown@example.test", ""); err != nil {
		t.Fatalf("unknown email must be accepted without error: %v", err)
	}
	if len(fixture.mail.recorded) != 0 {
		t.Fatalf("unknown email created a Mail intent: %+v", fixture.mail.recorded)
	}
	if err := fixture.service.RequestPasswordReset(ctx, "Members", "known@example.test", ""); err != nil {
		t.Fatal(err)
	}
	if len(fixture.mail.recorded) != 1 {
		t.Fatalf("known email did not create a Mail intent: %+v", fixture.mail.recorded)
	}
	fixture.mail.configured = false
	if err := fixture.service.RequestPasswordReset(ctx, "Members", "known@example.test", ""); !errors.Is(err, ErrMailUnavailable) {
		t.Fatalf("unconfigured mail error = %v, want ErrMailUnavailable", err)
	}
	if err := fixture.service.RequestEmailVerification(ctx, "Members", "known@example.test", ""); !errors.Is(err, ErrMailUnavailable) {
		t.Fatalf("unconfigured verification error = %v", err)
	}
}

func TestRecoveryTokenCipherIsBoundToItsContext(t *testing.T) {
	fixture := newRecoveryFixture(t, AuthConfig{EmailPasswordEnabled: true, SelfRegistration: true, SessionDurationDays: 7, EmailVerification: EmailVerificationOptional})
	ctx := context.Background()
	if _, err := fixture.service.Register(ctx, "Members", map[string]any{"email": "cipher@example.test"}, "cipher-password"); err != nil {
		t.Fatal(err)
	}
	// 已验证用户不会重复收到验证邮件，因此用密码重置验证投递负载边界。
	if err := fixture.service.RequestPasswordReset(ctx, "Members", "cipher@example.test", ""); err != nil {
		t.Fatal(err)
	}
	intent := fixture.mail.recorded[0]
	if _, _, err := fixture.service.RenderDeliveryPayload(ctx, intent.Kind, "rtk_"+strings.Repeat("f", 32), intent.Recipient); err == nil {
		t.Fatal("rendering an unknown payload reference must fail")
	}
	stored, _, err := fixture.service.RenderDeliveryPayload(ctx, intent.Kind, intent.PayloadRef, intent.Recipient)
	if err != nil || !strings.Contains(stored, "Modelry") {
		t.Fatalf("rendered subject = %q err=%v", stored, err)
	}
}
