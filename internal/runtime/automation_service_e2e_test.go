//go:build modelry_e2e

package runtime

import (
	"testing"
	"time"
)

func TestE2ERetryDelayAllowsSecondBoundarySignatureFixture(t *testing.T) {
	delay, err := parseE2EWebhookRetryDelay("1100")
	if err != nil || delay != 1100*time.Millisecond {
		t.Fatalf("1100ms E2E retry delay = %v, %v", delay, err)
	}
	for _, value := range []string{"0", "2001", "not-a-number"} {
		if _, err := parseE2EWebhookRetryDelay(value); err == nil {
			t.Errorf("invalid E2E retry delay %q was accepted", value)
		}
	}
}
