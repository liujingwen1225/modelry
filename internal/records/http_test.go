package records

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liujingwen1225/modelry/internal/recordevents"
)

func TestWriteRecordErrorExplainsDurableEventSizeLimit(t *testing.T) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/admin/api/v1/collections/col_posts/records", nil)

	writeRecordError(response, request, recordevents.ErrEventTooLarge)

	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if response.Code != http.StatusRequestEntityTooLarge || json.Unmarshal(response.Body.Bytes(), &envelope) != nil {
		t.Fatalf("oversized Event response = %d %s", response.Code, response.Body.String())
	}
	if envelope.Error.Code != "PAYLOAD_TOO_LARGE" || !strings.Contains(envelope.Error.Message, "1 MiB") || !strings.Contains(envelope.Error.Message, "retry") {
		t.Fatalf("oversized Event error was not actionable: %+v", envelope.Error)
	}
}
