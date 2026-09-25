package filestore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

// S3RequestTimeout 是单个 S3 请求的上限。
const S3RequestTimeout = RequestTimeout

// S3Config 是 S3-compatible Provider 的运行配置。
// AccessKey/SecretKey/SessionToken 由调用方解密后传入，本包只用于签名且从不记录它们。
type S3Config struct {
	Endpoint     string
	Region       string
	Bucket       string
	KeyPrefix    string
	PathStyle    bool
	AccessKey    []byte
	SecretKey    []byte
	SessionToken []byte
}

// S3 是 S3-compatible Storage Provider。
type S3 struct {
	endpoint     *url.URL
	region       string
	bucket       string
	keyPrefix    string
	pathStyle    bool
	signer       sigV4Signer
	client       *http.Client
	requestLimit time.Duration
	healthLimit  time.Duration
}

// ParseS3Endpoint 校验并规范化 Owner 提供的 endpoint。
// HTTPS 始终允许；HTTP 只允许 loopback、private、link-local 主机，供自托管 MinIO 使用。
func ParseS3Endpoint(raw string) (*url.URL, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("%w: endpoint is required", ErrInvalidArgument)
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("%w: endpoint is not a valid URL", ErrInvalidArgument)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return nil, fmt.Errorf("%w: endpoint must use https", ErrInvalidArgument)
	}
	if parsed.Host == "" || parsed.Hostname() == "" {
		return nil, fmt.Errorf("%w: endpoint must contain a host", ErrInvalidArgument)
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%w: endpoint must not contain user information, a query, or a fragment", ErrInvalidArgument)
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return nil, fmt.Errorf("%w: endpoint must not contain a path", ErrInvalidArgument)
	}
	if parsed.Scheme == "http" {
		local, localErr := isLocalEndpoint(parsed.Hostname())
		if localErr != nil || !local {
			return nil, fmt.Errorf("%w: plain HTTP is only allowed for loopback, private, or link-local endpoints", ErrInvalidArgument)
		}
	}
	parsed.Path = ""
	parsed.RawPath = ""
	return parsed, nil
}

func isLocalEndpoint(host string) (bool, error) {
	normalized := strings.ToLower(strings.TrimSpace(host))
	if normalized == "localhost" {
		return true, nil
	}
	if ip := net.ParseIP(normalized); ip != nil {
		return isLocalIP(ip), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), S3RequestTimeout)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, normalized)
	if err != nil || len(addresses) == 0 {
		return false, ErrInvalidArgument
	}
	for _, address := range addresses {
		if !isLocalIP(address.IP) {
			return false, nil
		}
	}
	return true, nil
}

func isLocalIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

// NewS3 创建 S3-compatible Provider。
func NewS3(config S3Config) (*S3, error) {
	endpoint, err := ParseS3Endpoint(config.Endpoint)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.Region) == "" || strings.TrimSpace(config.Bucket) == "" {
		return nil, fmt.Errorf("%w: S3-compatible region and bucket are required", ErrInvalidArgument)
	}
	if len(config.AccessKey) == 0 || len(config.SecretKey) == 0 {
		return nil, ErrCredentialUnavailable
	}
	prefix := config.KeyPrefix
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	transport := &http.Transport{
		Proxy:                 nil,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          8,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: RequestTimeout,
		ExpectContinueTimeout: time.Second,
	}
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("file storage requests must not follow redirects")
		},
	}
	return &S3{
		endpoint: endpoint, region: strings.TrimSpace(config.Region), bucket: strings.TrimSpace(config.Bucket),
		keyPrefix: prefix, pathStyle: config.PathStyle,
		signer: sigV4Signer{
			accessKey: string(config.AccessKey), secretKey: string(config.SecretKey),
			sessionToken: string(config.SessionToken), region: strings.TrimSpace(config.Region), service: "s3",
		},
		client: client, requestLimit: S3RequestTimeout, healthLimit: HealthTimeout,
	}, nil
}

func (provider *S3) Name() string { return "s3" }

func (provider *S3) Label() string { return "S3-compatible" }

func (provider *S3) objectKey(objectKey string) (string, error) {
	if !ValidObjectKey(objectKey) {
		return "", ErrInvalidArgument
	}
	return provider.keyPrefix + objectKey, nil
}

func (provider *S3) objectURL(objectKey string) (*url.URL, error) {
	key, err := provider.objectKey(objectKey)
	if err != nil {
		return nil, err
	}
	target := *provider.endpoint
	segments := strings.Split(key, "/")
	encoded := make([]string, 0, len(segments))
	for _, segment := range segments {
		encoded = append(encoded, uriEncode(segment, true))
	}
	escapedKey := strings.Join(encoded, "/")
	if provider.pathStyle {
		target.Path = "/" + provider.bucket + "/" + strings.Join(segments, "/")
		target.RawPath = "/" + uriEncode(provider.bucket, true) + "/" + escapedKey
		return &target, nil
	}
	target.Host = bucketHost(provider.bucket, provider.endpoint)
	target.Path = "/" + strings.Join(segments, "/")
	target.RawPath = "/" + escapedKey
	return &target, nil
}

func bucketHost(bucket string, endpoint *url.URL) string {
	host := bucket + "." + endpoint.Hostname()
	if port := endpoint.Port(); port != "" {
		host += ":" + port
	}
	return host
}

func (provider *S3) newRequest(ctx context.Context, method string, objectKey string, body io.Reader, size int64) (*http.Request, error) {
	target, err := provider.objectURL(objectKey)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, fmt.Errorf("%w: request cannot be created", ErrInvalidArgument)
	}
	request.Host = target.Host
	request.ContentLength = size
	return request, nil
}

// do 发送一次有界请求；它不跟随重定向，也不使用代理。
func (provider *S3) do(request *http.Request, payloadHash string) (*http.Response, error) {
	request.Header.Set("X-Amz-Content-Sha256", payloadHash)
	if err := provider.signer.sign(request, payloadHash, time.Now().UTC()); err != nil {
		return nil, err
	}
	response, err := provider.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%w: provider request failed", ErrUnavailable)
	}
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		return response, nil
	case response.StatusCode == http.StatusNotFound:
		_ = response.Body.Close()
		return nil, ErrNotFound
	case response.StatusCode == http.StatusConflict, response.StatusCode == http.StatusPreconditionFailed:
		_ = response.Body.Close()
		return nil, ErrObjectExists
	case response.StatusCode == http.StatusUnauthorized, response.StatusCode == http.StatusForbidden:
		_ = response.Body.Close()
		return nil, ErrCredentialUnavailable
	default:
		_ = response.Body.Close()
		return nil, ErrUnavailable
	}
}

func (provider *S3) Promote(ctx context.Context, objectKey string, staged Staged) error {
	if provider == nil {
		return ErrUnavailable
	}
	if err := ValidateStaged(staged); err != nil {
		return err
	}
	if _, err := provider.objectKey(objectKey); err != nil {
		return err
	}
	requestCtx, cancel := context.WithTimeout(ctx, provider.requestLimit)
	defer cancel()
	if _, err := provider.Stat(requestCtx, objectKey); err == nil {
		return ErrObjectExists
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	file, err := os.Open(staged.Path)
	if err != nil {
		return fmt.Errorf("%w: staged upload is no longer available", ErrInvalidArgument)
	}
	defer file.Close()
	hasher := sha256.New()
	written, err := io.Copy(hasher, file)
	if err != nil {
		return fmt.Errorf("%w: staged upload cannot be read", ErrInvalidArgument)
	}
	if written != staged.Size || written > MaxObjectBytes {
		return fmt.Errorf("%w: staged upload size changed before binding", ErrInvalidArgument)
	}
	payloadHash := hex.EncodeToString(hasher.Sum(nil))
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	contentType := staged.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	request, err := provider.newRequest(requestCtx, http.MethodPut, objectKey, file, staged.Size)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", contentType)
	response, err := provider.do(request, payloadHash)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	confirmed, err := provider.Stat(requestCtx, objectKey)
	if err != nil {
		return err
	}
	if confirmed.Size != staged.Size {
		return fmt.Errorf("%w: stored object size differs from the staged upload", ErrUnavailable)
	}
	return nil
}

func (provider *S3) Open(ctx context.Context, objectKey string) (io.ReadCloser, Info, error) {
	if provider == nil {
		return nil, Info{}, ErrUnavailable
	}
	requestCtx, cancel := context.WithTimeout(ctx, provider.requestLimit)
	request, err := provider.newRequest(requestCtx, http.MethodGet, objectKey, nil, 0)
	if err != nil {
		cancel()
		return nil, Info{}, err
	}
	response, err := provider.do(request, emptyPayloadSHA256)
	if err != nil {
		cancel()
		return nil, Info{}, err
	}
	contentType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return &cancelReadCloser{body: response.Body, cancel: cancel}, Info{Size: response.ContentLength, ContentType: contentType}, nil
}

func (provider *S3) Stat(ctx context.Context, objectKey string) (Info, error) {
	if provider == nil {
		return Info{}, ErrUnavailable
	}
	requestCtx, cancel := context.WithTimeout(ctx, provider.requestLimit)
	defer cancel()
	request, err := provider.newRequest(requestCtx, http.MethodHead, objectKey, nil, 0)
	if err != nil {
		return Info{}, err
	}
	response, err := provider.do(request, emptyPayloadSHA256)
	if err != nil {
		return Info{}, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	contentType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return Info{Size: response.ContentLength, ContentType: contentType}, nil
}

func (provider *S3) Delete(ctx context.Context, objectKey string) error {
	if provider == nil {
		return ErrUnavailable
	}
	requestCtx, cancel := context.WithTimeout(ctx, provider.requestLimit)
	defer cancel()
	request, err := provider.newRequest(requestCtx, http.MethodDelete, objectKey, nil, 0)
	if err != nil {
		return err
	}
	response, err := provider.do(request, emptyPayloadSHA256)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, response.Body)
	return response.Body.Close()
}

type listBucketResult struct {
	XMLName               xml.Name "xml:\"ListBucketResult\""
	IsTruncated           bool     "xml:\"IsTruncated\""
	NextContinuationToken string   "xml:\"NextContinuationToken\""
	Contents              []struct {
		Key          string "xml:\"Key\""
		Size         int64  "xml:\"Size\""
		LastModified string "xml:\"LastModified\""
	} "xml:\"Contents\""
}

func (provider *S3) List(ctx context.Context, cursor string, limit int) (Page, error) {
	if provider == nil {
		return Page{}, ErrUnavailable
	}
	size, err := validListLimit(limit)
	if err != nil {
		return Page{}, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, provider.healthLimit)
	defer cancel()
	target := *provider.endpoint
	if provider.pathStyle {
		target.Path = "/" + provider.bucket
	} else {
		target.Host = bucketHost(provider.bucket, provider.endpoint)
		target.Path = "/"
	}
	query := target.Query()
	query.Set("list-type", "2")
	query.Set("max-keys", fmt.Sprint(size))
	if provider.keyPrefix != "" {
		query.Set("prefix", provider.keyPrefix)
	}
	if cursor != "" {
		query.Set("continuation-token", cursor)
	}
	target.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, target.String(), nil)
	if err != nil {
		return Page{}, fmt.Errorf("%w: list request cannot be created", ErrInvalidArgument)
	}
	request.Host = target.Host
	response, err := provider.do(request, emptyPayloadSHA256)
	if err != nil {
		return Page{}, err
	}
	defer response.Body.Close()
	var payload listBucketResult
	if err := xml.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload); err != nil {
		return Page{}, fmt.Errorf("%w: listing response is not valid XML", ErrUnavailable)
	}
	page := Page{Objects: make([]Object, 0, len(payload.Contents))}
	for _, item := range payload.Contents {
		key := item.Key
		if provider.keyPrefix != "" {
			if !strings.HasPrefix(key, provider.keyPrefix) {
				continue
			}
			key = strings.TrimPrefix(key, provider.keyPrefix)
		}
		if !ValidObjectKey(key) {
			continue
		}
		modified, err := time.Parse(time.RFC3339, item.LastModified)
		if err != nil {
			modified = time.Time{}
		}
		page.Objects = append(page.Objects, Object{Key: key, Size: item.Size, ModifiedAt: modified.UTC()})
	}
	if payload.IsTruncated && payload.NextContinuationToken != "" {
		page.NextCursor = payload.NextContinuationToken
	}
	sort.Slice(page.Objects, func(i, j int) bool { return page.Objects[i].Key < page.Objects[j].Key })
	return page, nil
}

func (provider *S3) Health(ctx context.Context) Health {
	if provider == nil {
		return Health{State: StateUnavailable, Message: "S3-compatible Storage is not initialized.", Hint: "Save the Provider configuration again."}
	}
	probeCtx, cancel := context.WithTimeout(ctx, provider.healthLimit)
	defer cancel()
	if _, err := provider.List(probeCtx, "", 1); err != nil {
		if errors.Is(err, ErrCredentialUnavailable) {
			return Health{State: StateUnavailable, Message: "The S3-compatible credentials were rejected.", Hint: "Select a valid access key and secret key Secret, then test the connection again."}
		}
		if probeCtx.Err() != nil {
			return Health{State: StateUnknown, Message: "The S3-compatible Provider did not respond in time.", Hint: "Check the endpoint, then test the connection again."}
		}
		return Health{State: StateDegraded, Message: "The S3-compatible Provider is not reachable.", Hint: "Check the endpoint, bucket, and network access, then test the connection again."}
	}
	return Health{State: StateReady, Message: "S3-compatible Storage is responding.", Hint: ""}
}

// cancelReadCloser 在关闭响应体时同时释放请求 deadline。
type cancelReadCloser struct {
	body   io.ReadCloser
	cancel context.CancelFunc
}

func (value *cancelReadCloser) Read(buffer []byte) (int, error) { return value.body.Read(buffer) }

func (value *cancelReadCloser) Close() error {
	err := value.body.Close()
	value.cancel()
	return err
}
