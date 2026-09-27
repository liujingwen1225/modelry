package mail

import (
	"crypto/rand"
	"encoding/hex"
)

func randRead(value []byte) (int, error) { return rand.Read(value) }

func hexEncode(value []byte) string { return hex.EncodeToString(value) }
