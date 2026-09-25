package serviceaccounts

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/liujingwen1225/modelry/internal/permissions"
)

// CustomOperationsV1 返回当前受支持的自定义 Permission 操作枚举副本。
func CustomOperationsV1() []Operation { return permissions.AllOperations() }

// normalizeGrant 校验并归一化 Permission，并把共享校验结果转换为本包的 ValidationFailure。
func normalizeGrant(preset Preset, version int, operations []Operation) (Grant, error) {
	grant, err := permissions.NormalizeGrant(preset, version, operations)
	if err == nil {
		return grant, nil
	}
	var invalid *permissions.InvalidGrant
	if errors.As(err, &invalid) {
		return Grant{}, validationError(invalid.Path, invalid.Code, invalid.Message)
	}
	return Grant{}, err
}

func grantAllows(grant Grant, operation Operation) bool {
	return permissions.GrantAllows(grant, operation)
}

func grantWithin(candidate, authority Grant) bool {
	return permissions.GrantWithin(candidate, authority)
}

func knownOperation(operation Operation) bool { return permissions.KnownOperation(operation) }

func validationError(path, code, message string) error {
	return &ValidationFailure{Path: path, Code: code, Message: message}
}

func grantFromColumns(preset string, version int, encoded string) (Grant, error) {
	var operations []Operation
	if err := json.Unmarshal([]byte(encoded), &operations); err != nil {
		return Grant{}, fmt.Errorf("%w: decode persisted Service Account Permission: %v", ErrStorage, err)
	}
	grant, err := normalizeGrant(Preset(preset), version, operations)
	if err != nil {
		return Grant{}, fmt.Errorf("%w: validate persisted Service Account Permission: %v", ErrStorage, err)
	}
	return grant, nil
}
