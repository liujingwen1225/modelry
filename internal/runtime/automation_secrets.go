package runtime

import (
	"context"
	"errors"

	"github.com/liujingwen1225/modelry/internal/automation"
	"github.com/liujingwen1225/modelry/internal/extensions"
)

type runtimeSecretProvider struct{ service *extensions.Service }

func (provider runtimeSecretProvider) SecretMetadata(ctx context.Context, id string) (string, bool, error) {
	return provider.service.SecretMetadata(ctx, id)
}

func (provider runtimeSecretProvider) WithSecretValue(ctx context.Context, id string, use func([]byte) error) error {
	err := provider.service.WithSecretValue(ctx, id, use)
	switch {
	case errors.Is(err, extensions.ErrSecretKeyUnavailable):
		return errors.Join(automation.ErrSecretKeyUnavailable, err)
	case errors.Is(err, extensions.ErrSecretNotAvailable):
		return errors.Join(automation.ErrSecretNotAvailable, err)
	default:
		return err
	}
}
