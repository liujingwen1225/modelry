package authorization

import (
	"context"
	"encoding/json"
)

type PrincipalType string

const (
	PrincipalAnonymous      PrincipalType = "anonymous"
	PrincipalOwner          PrincipalType = "owner"
	PrincipalApplication    PrincipalType = "applicationUser"
	PrincipalServiceAccount PrincipalType = "serviceAccount"
)

type Principal struct {
	Type PrincipalType
	ID   string
}

type Operation string

const (
	OperationList   Operation = "list"
	OperationView   Operation = "view"
	OperationCreate Operation = "create"
	OperationUpdate Operation = "update"
	OperationDelete Operation = "delete"
)

type Record struct {
	ID     string
	Values map[string]any
}

type Decision struct {
	Allowed bool
	Code    string
	Message string
	Reason  json.RawMessage
}

type Evaluator interface {
	Evaluate(context.Context, string, Operation, Principal, *Record) (Decision, error)
}

type SessionAuthenticator interface {
	AuthenticateSession(context.Context, string) (Principal, error)
}
