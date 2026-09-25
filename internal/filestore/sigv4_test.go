package filestore

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestSigV4MatchesAWSTestSuiteGetVanilla 用 AWS SigV4 官方测试套件的 get-vanilla 向量锚定算法。
// 向量：AKIDEXAMPLE / wJalrXUtnFEMI+K7MDENG+bPxRfiCYEXAMPLEKEY，20150830T123600Z，us-east-1，service。
func TestSigV4MatchesAWSTestSuiteGetVanilla(t *testing.T) {
	now, err := time.Parse("20060102T150405Z", "20150830T123600Z")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "https://example.amazonaws.com/", nil)
	request.Host = "example.amazonaws.com"
	signer := sigV4Signer{
		accessKey: "AKIDEXAMPLE",
		secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		region:    "us-east-1",
		service:   "service",
	}
	canonical, signedHeaders, amzDate, err := signer.canonicalRequest(request, "", now)
	if err != nil {
		t.Fatal(err)
	}
	expectedCanonical := strings.Join([]string{
		"GET",
		"/",
		"",
		"host:example.amazonaws.com",
		"x-amz-date:20150830T123600Z",
		"",
		"host;x-amz-date",
		emptyPayloadSHA256,
	}, "\n")
	if canonical != expectedCanonical {
		t.Fatalf("canonical request mismatch:\n got: %q\nwant: %q", canonical, expectedCanonical)
	}
	if strings.Join(signedHeaders, ";") != "host;x-amz-date" || amzDate != "20150830T123600Z" {
		t.Fatalf("signed headers=%v amzDate=%q", signedHeaders, amzDate)
	}
	stringToSign := strings.Join([]string{
		sigV4Algorithm,
		amzDate,
		"20150830/us-east-1/service/aws4_request",
		hexSHA256([]byte(canonical)),
	}, "\n")
	if got := hexSHA256([]byte(canonical)); got != "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63" {
		t.Fatalf("canonical request hash = %s", got)
	}
	if err := signer.sign(request, "", now); err != nil {
		t.Fatal(err)
	}
	authorization := request.Header.Get("Authorization")
	const expectedSignature = "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
	if !strings.Contains(authorization, "Signature="+expectedSignature) {
		t.Logf("stringToSign=%q", stringToSign)
		t.Fatalf("Authorization signature mismatch: %s", authorization)
	}
	if !strings.Contains(authorization, "SignedHeaders=host;x-amz-date") {
		t.Fatalf("Authorization signed headers mismatch: %s", authorization)
	}
}

func TestSigV4SignsPayloadHashAndSessionToken(t *testing.T) {
	now, err := time.Parse("20060102T150405Z", "20150830T123600Z")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "https://s3.example.com/bucket/prefix/obj_0123456789abcdef0123456789abcdef", strings.NewReader("payload"))
	request.Host = "s3.example.com"
	signer := sigV4Signer{
		accessKey: "AKIDEXAMPLE", secretKey: "secret-example", sessionToken: "session-example",
		region: "us-east-1", service: "s3",
	}
	payloadHash := hexSHA256([]byte("payload"))
	if err := signer.sign(request, payloadHash, now); err != nil {
		t.Fatal(err)
	}
	authorization := request.Header.Get("Authorization")
	for _, expected := range []string{
		"SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
		"Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request",
	} {
		if !strings.Contains(authorization, expected) {
			t.Fatalf("Authorization %q missing %q", authorization, expected)
		}
	}
	if got := request.Header.Get("X-Amz-Content-Sha256"); got != payloadHash {
		t.Fatalf("payload hash header = %q", got)
	}
	if got := request.Header.Get("X-Amz-Security-Token"); got != "session-example" {
		t.Fatalf("session token header = %q", got)
	}
	if strings.Contains(authorization, "secret-example") {
		t.Fatalf("Authorization leaked the secret: %s", authorization)
	}
}

func TestCanonicalQuerySortsEncodedPairs(t *testing.T) {
	got := canonicalQuery(map[string][]string{
		"list-type": {"2"},
		"max-keys":  {"10"},
		"prefix":    {"a b/c"},
	})
	want := "list-type=2&max-keys=10&prefix=a%20b%2Fc"
	if got != want {
		t.Fatalf("canonical query = %q, want %q", got, want)
	}
}

func TestUriEncodeMatchesRFC3986(t *testing.T) {
	if got := uriEncode("a b/c~d", false); got != "a%20b/c~d" {
		t.Fatalf("uriEncode = %q", got)
	}
	if got := uriEncode("a b/c~d", true); got != "a%20b%2Fc~d" {
		t.Fatalf("uriEncode slash = %q", got)
	}
}
