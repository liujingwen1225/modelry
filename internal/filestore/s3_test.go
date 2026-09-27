package filestore

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	fakeAccessKey = "ACCESSKEYEXAMPLE"
	fakeSecretKey = "secret-key-example"
)

type fakeObject struct {
	body        []byte
	contentType string
	modified    time.Time
}

// fakeS3 是最小的 S3-compatible 服务：它独立复核 SigV4 签名与 payload 哈希。
type fakeS3 struct {
	mu          sync.Mutex
	bucket      string
	objects     map[string]fakeObject
	requests    int
	listFailure bool
}

func newFakeS3(t *testing.T, bucket string) (*fakeS3, *httptest.Server) {
	t.Helper()
	server := &fakeS3{bucket: bucket, objects: make(map[string]fakeObject)}
	handler := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !server.verifySignature(t, r) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		server.mu.Lock()
		server.requests++
		server.mu.Unlock()
		path := strings.TrimPrefix(r.URL.Path, "/")
		if !strings.HasPrefix(path, bucket+"/") && path != bucket {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		key := strings.TrimPrefix(strings.TrimPrefix(path, bucket), "/")
		switch {
		case r.Method == http.MethodGet && r.URL.Query().Get("list-type") == "2":
			server.list(w, r, key)
		case r.Method == http.MethodPut:
			body, err := io.ReadAll(io.LimitReader(r.Body, MaxObjectBytes+1))
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			server.mu.Lock()
			server.objects[key] = fakeObject{body: body, contentType: r.Header.Get("Content-Type"), modified: time.Now().UTC()}
			server.mu.Unlock()
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodGet || r.Method == http.MethodHead:
			server.mu.Lock()
			object, exists := server.objects[key]
			server.mu.Unlock()
			if !exists {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", object.contentType)
			w.Header().Set("Content-Length", strconv.Itoa(len(object.body)))
			w.WriteHeader(http.StatusOK)
			if r.Method == http.MethodGet {
				_, _ = w.Write(object.body)
			}
		case r.Method == http.MethodDelete:
			server.mu.Lock()
			_, exists := server.objects[key]
			delete(server.objects, key)
			server.mu.Unlock()
			if !exists {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(handler.Close)
	return server, handler
}

type listBucketXML struct {
	XMLName               xml.Name `xml:"ListBucketResult"`
	IsTruncated           bool     `xml:"IsTruncated"`
	NextContinuationToken string   `xml:"NextContinuationToken,omitempty"`
	Contents              []struct {
		Key          string `xml:"Key"`
		Size         int64  `xml:"Size"`
		LastModified string `xml:"LastModified"`
	} `xml:"Contents"`
}

func (server *fakeS3) list(w http.ResponseWriter, r *http.Request, _ string) {
	server.mu.Lock()
	failure := server.listFailure
	keys := make([]string, 0, len(server.objects))
	for key := range server.objects {
		keys = append(keys, key)
	}
	server.mu.Unlock()
	if failure {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	sort.Strings(keys)
	prefix := r.URL.Query().Get("prefix")
	limit, err := strconv.Atoi(r.URL.Query().Get("max-keys"))
	if err != nil || limit <= 0 {
		limit = 1000
	}
	start := 0
	if token := r.URL.Query().Get("continuation-token"); token != "" {
		start, _ = strconv.Atoi(token)
	}
	payload := listBucketXML{}
	count := 0
	for index := start; index < len(keys); index++ {
		key := keys[index]
		if prefix != "" && !strings.HasPrefix(key, prefix) {
			continue
		}
		if count == limit {
			payload.IsTruncated = true
			payload.NextContinuationToken = strconv.Itoa(index)
			break
		}
		server.mu.Lock()
		object := server.objects[key]
		server.mu.Unlock()
		payload.Contents = append(payload.Contents, struct {
			Key          string `xml:"Key"`
			Size         int64  `xml:"Size"`
			LastModified string `xml:"LastModified"`
		}{Key: key, Size: int64(len(object.body)), LastModified: object.modified.Format(time.RFC3339)})
		count++
	}
	w.Header().Set("Content-Type", "application/xml")
	_ = xml.NewEncoder(w).Encode(payload)
}

// verifySignature 独立重建 canonical request 并复核签名，不依赖被测实现。
func (server *fakeS3) verifySignature(t *testing.T, r *http.Request) bool {
	t.Helper()
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, sigV4Algorithm+" ") {
		return false
	}
	fields := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(authorization, sigV4Algorithm+" "), ",") {
		part = strings.TrimSpace(part)
		key, value, found := strings.Cut(part, "=")
		if found {
			fields[key] = value
		}
	}
	credential := fields["Credential"]
	if !strings.HasPrefix(credential, fakeAccessKey+"/") {
		return false
	}
	signedHeaders := strings.Split(fields["SignedHeaders"], ";")
	canonicalHeaders := make([]string, 0, len(signedHeaders))
	for _, name := range signedHeaders {
		value := r.Header.Get(http.CanonicalHeaderKey(name))
		if name == "host" {
			value = r.Host
		}
		canonicalHeaders = append(canonicalHeaders, name+":"+strings.Join(strings.Fields(value), " "))
	}
	payloadHash := r.Header.Get("X-Amz-Content-Sha256")
	if payloadHash != "" {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return false
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != payloadHash {
			return false
		}
	} else {
		payloadHash = emptyPayloadSHA256
	}
	query := canonicalQuery(r.URL.Query())
	canonical := strings.Join([]string{
		r.Method,
		canonicalURI(r.URL.EscapedPath()),
		query,
		strings.Join(canonicalHeaders, "\n") + "\n",
		fields["SignedHeaders"],
		payloadHash,
	}, "\n")
	scope := strings.TrimPrefix(credential, fakeAccessKey+"/")
	stringToSign := strings.Join([]string{
		sigV4Algorithm,
		r.Header.Get("X-Amz-Date"),
		scope,
		hexSHA256([]byte(canonical)),
	}, "\n")
	parts := strings.Split(scope, "/")
	if len(parts) != 4 {
		return false
	}
	signature := hex.EncodeToString(hmacSHA256(signingKey(fakeSecretKey, parts[0], parts[1], parts[2]), []byte(stringToSign)))
	if !hmac.Equal([]byte(signature), []byte(fields["Signature"])) {
		t.Errorf("fake S3 rejected request signature for %s %s", r.Method, r.URL.Path)
		return false
	}
	return true
}

func newS3Fixture(t *testing.T) (*S3, *fakeS3, string) {
	t.Helper()
	bucket := "modelry-test"
	server, endpoint := newFakeS3(t, bucket)
	provider, err := NewS3(S3Config{
		Endpoint: endpoint.URL, Region: "us-east-1", Bucket: bucket, KeyPrefix: "modelry/", PathStyle: true,
		AccessKey: []byte(fakeAccessKey), SecretKey: []byte(fakeSecretKey),
	})
	if err != nil {
		t.Fatal(err)
	}
	return provider, server, bucket
}

func TestS3PromoteOpenStatDeleteRoundTrip(t *testing.T) {
	provider, server, _ := newS3Fixture(t)
	key := "obj_" + strings.Repeat("a", 32)
	contents := "s3 attachment bytes"
	stagedPath := writeStaged(t, t.TempDir(), "tmp_"+strings.Repeat("b", 32), contents)
	if err := provider.Promote(context.Background(), key, Staged{Path: stagedPath, Size: int64(len(contents)), ContentType: "text/plain"}); err != nil {
		t.Fatal(err)
	}
	file, info, err := provider.Open(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil || string(body) != contents || info.Size != int64(len(contents)) || info.ContentType != "text/plain" {
		t.Fatalf("opened object body=%q info=%+v err=%v", body, info, err)
	}
	stat, err := provider.Stat(context.Background(), key)
	if err != nil || stat.Size != info.Size {
		t.Fatalf("stat = %+v err=%v", stat, err)
	}
	if err := provider.Promote(context.Background(), key, Staged{Path: stagedPath, Size: int64(len(contents)), ContentType: "text/plain"}); !errors.Is(err, ErrObjectExists) {
		t.Fatalf("promote existing object error = %v", err)
	}
	if err := provider.Delete(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	if err := provider.Delete(context.Background(), key); err != nil {
		t.Fatalf("delete must be idempotent: %v", err)
	}
	if _, err := provider.Stat(context.Background(), key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stat deleted object error = %v", err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.objects) != 0 {
		t.Fatalf("fake S3 still holds %d objects", len(server.objects))
	}
}

func TestS3ListStripsPrefixAndPaginates(t *testing.T) {
	provider, _, _ := newS3Fixture(t)
	var keys []string
	for index := 0; index < 3; index++ {
		key := "obj_" + strings.Repeat(strconv.Itoa(index), 32)
		keys = append(keys, key)
		stagedPath := writeStaged(t, t.TempDir(), "tmp_"+strings.Repeat(strconv.Itoa(index), 32), fmt.Sprintf("payload-%d", index))
		if err := provider.Promote(context.Background(), key, Staged{Path: stagedPath, Size: int64(len(fmt.Sprintf("payload-%d", index))), ContentType: "text/plain"}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := provider.List(context.Background(), "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Objects) != 2 || first.NextCursor == "" {
		t.Fatalf("first page = %+v", first)
	}
	second, err := provider.List(context.Background(), first.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Objects) != 1 {
		t.Fatalf("second page = %+v", second)
	}
	seen := append([]string{}, first.Objects[0].Key, first.Objects[1].Key, second.Objects[0].Key)
	sort.Strings(seen)
	if strings.Join(seen, ",") != strings.Join(keys, ",") {
		t.Fatalf("list keys = %v, want %v", seen, keys)
	}
	for _, object := range first.Objects {
		if !ValidObjectKey(object.Key) {
			t.Fatalf("list returned a key without the provider prefix stripped: %q", object.Key)
		}
	}
}

func TestS3HealthReportsReadyAndDegraded(t *testing.T) {
	provider, server, _ := newS3Fixture(t)
	if health := provider.Health(context.Background()); health.State != StateReady {
		t.Fatalf("ready health = %+v", health)
	}
	server.mu.Lock()
	server.listFailure = true
	server.mu.Unlock()
	health := provider.Health(context.Background())
	if health.State != StateDegraded {
		t.Fatalf("degraded health = %+v", health)
	}
	if strings.Contains(health.Message, fakeSecretKey) || strings.Contains(health.Hint, fakeSecretKey) {
		t.Fatalf("health leaked the credential: %+v", health)
	}
}

func TestParseS3EndpointRules(t *testing.T) {
	valid := []string{"https://s3.example.com", "http://127.0.0.1:9000", "http://localhost:9000", "http://10.1.2.3:9000", "http://192.168.1.20:9000"}
	for _, value := range valid {
		if _, err := ParseS3Endpoint(value); err != nil {
			t.Errorf("ParseS3Endpoint(%q) error = %v", value, err)
		}
	}
	invalid := []string{"", "ftp://s3.example.com", "http://s3.example.com", "https://user:pass@s3.example.com", "https://s3.example.com?x=1", "https://s3.example.com#frag", "https://s3.example.com/prefix"}
	for _, value := range invalid {
		if _, err := ParseS3Endpoint(value); err == nil {
			t.Errorf("ParseS3Endpoint(%q) unexpectedly succeeded", value)
		}
	}
}

func TestS3ConfigurationErrorsDoNotLeakCredentials(t *testing.T) {
	_, err := NewS3(S3Config{Endpoint: "https://s3.example.com", Region: "us-east-1", Bucket: "bucket"})
	if !errors.Is(err, ErrCredentialUnavailable) {
		t.Fatalf("missing credentials error = %v", err)
	}
	if strings.Contains(err.Error(), fakeSecretKey) {
		t.Fatalf("error leaked secret: %v", err)
	}
}
