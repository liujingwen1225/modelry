// Package safehttp 为 After-commit Extension Hook 提供受限 HTTPS 请求。
package safehttp

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxOriginGrants       = 32
	maxRequestsPerRun     = 3
	maxHeaderValueBytes   = 8 * 1024
	maxRequestBodyBytes   = 64 * 1024
	maxResponseBodyBytes  = 256 * 1024
	maxResponseHeaderSize = 32 * 1024
	requestDeadline       = 2 * time.Second
)

// 错误值只包含合同允许的稳定类别，不包装底层网络错误。
var (
	ErrOriginNotAllowed      = errors.New("originNotAllowed")
	ErrExternalRequestFailed = errors.New("externalRequestFailed")
)

var (
	requestHeaderNames = map[string]string{
		"accept":        "Accept",
		"content-type":  "Content-Type",
		"authorization": "Authorization",
		"x-api-key":     "X-Api-Key",
		"if-match":      "If-Match",
		"if-none-match": "If-None-Match",
	}
	responseHeaderNames = []string{"Content-Type", "ETag", "Last-Modified", "Retry-After", "X-Request-Id"}
	blockedIPv4Prefixes = mustPrefixes(
		"0.0.0.0/8",
		"10.0.0.0/8",
		"100.64.0.0/10",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"172.16.0.0/12",
		"192.0.0.0/24",
		"192.0.2.0/24",
		"192.88.99.0/24",
		"192.168.0.0/16",
		"198.18.0.0/15",
		"198.51.100.0/24",
		"203.0.113.0/24",
		"224.0.0.0/4",
		"240.0.0.0/4",
	)
	blockedIPv6Prefixes = mustPrefixes(
		"2001:db8::/32",
	)
	// 按 IANA 2025-10 分配表只接受已分配的 IPv6 全局单播块；未来分配需更新此表。
	assignedIPv6Prefixes = mustPrefixes(
		"2001:200::/23",
		"2001:400::/23",
		"2001:600::/23",
		"2001:800::/22",
		"2001:c00::/23",
		"2001:e00::/23",
		"2001:1200::/23",
		"2001:1400::/22",
		"2001:1800::/23",
		"2001:1a00::/23",
		"2001:1c00::/22",
		"2001:2000::/19",
		"2001:4000::/23",
		"2001:4200::/23",
		"2001:4400::/23",
		"2001:4600::/23",
		"2001:4800::/23",
		"2001:4a00::/23",
		"2001:4c00::/23",
		"2001:5000::/20",
		"2001:8000::/19",
		"2001:a000::/20",
		"2001:b000::/20",
		"2003::/18",
		"2400::/12",
		"2410::/12",
		"2600::/12",
		"2610::/23",
		"2620::/23",
		"2630::/12",
		"2800::/12",
		"2a00::/12",
		"2a10::/12",
		"2c00::/12",
	)
)

// Request 表示一次 modelry.http.request 调用；Body 必须是 UTF-8 字符串，空串表示省略或空请求体。
type Request struct {
	Origin  string
	Path    string
	Method  string
	Headers map[string]string
	Body    string
}

// Response 仅包含状态码、UTF-8 响应体和白名单内的响应头。
type Response struct {
	Status  int
	Headers map[string]string
	Body    string
}

// Resolver 是客户端执行地址解析的接口。
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// DialContextFunc 是拨号接口；生产构造固定使用 net.Dialer。
type DialContextFunc func(ctx context.Context, network, address string) (net.Conn, error)

// Client 限定于一次 Hook Run，单个实例最多执行三次请求。
type Client struct {
	origins  map[string]origin
	resolver Resolver
	dial     DialContextFunc
	tls      *tls.Config

	mu       sync.Mutex
	requests int
}

type origin struct {
	host string
	port string
}

// New 使用一次 Hook Run 显式配置的 HTTPS Origin Grant 创建客户端。
func New(grants []string) (*Client, error) {
	return newClient(grants, net.DefaultResolver, (&net.Dialer{}).DialContext, nil)
}

func newClient(grants []string, resolver Resolver, dial DialContextFunc, tlsConfig *tls.Config) (*Client, error) {
	if len(grants) > maxOriginGrants {
		return nil, ErrOriginNotAllowed
	}
	if resolver == nil || dial == nil {
		return nil, ErrOriginNotAllowed
	}
	client := &Client{
		origins:  make(map[string]origin, len(grants)),
		resolver: resolver,
		dial:     dial,
		tls:      tlsConfig,
	}
	for _, value := range grants {
		normalized, err := NormalizeOrigin(value)
		if err != nil {
			return nil, ErrOriginNotAllowed
		}
		parsed, err := parseNormalizedOrigin(normalized)
		if err != nil {
			return nil, ErrOriginNotAllowed
		}
		client.origins[normalized] = parsed
	}
	return client, nil
}

// NormalizeOrigin 校验并规范化 HTTPS DNS Origin：域名转为小写、去掉一个末尾根点、省略 443 端口。
func NormalizeOrigin(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil {
		return "", ErrOriginNotAllowed
	}
	if !strings.EqualFold(parsed.Scheme, "https") || parsed.Opaque != "" || parsed.User != nil || parsed.Host == "" ||
		parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery ||
		parsed.Fragment != "" || parsed.RawFragment != "" {
		return "", ErrOriginNotAllowed
	}
	if strings.HasSuffix(parsed.Host, ":") {
		return "", ErrOriginNotAllowed
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if !validDNSName(host) || net.ParseIP(host) != nil {
		return "", ErrOriginNotAllowed
	}
	port := parsed.Port()
	if port != "" {
		portNumber, parseErr := strconv.Atoi(port)
		if parseErr != nil || portNumber < 1 || portNumber > 65535 || strconv.Itoa(portNumber) != port {
			return "", ErrOriginNotAllowed
		}
		if portNumber == 443 {
			port = ""
		}
	}
	if port == "" {
		return "https://" + host, nil
	}
	return "https://" + host + ":" + port, nil
}

// Request 执行一次受限 HTTPS 请求；所有错误仅返回泛化类别。
func (c *Client) Request(parent context.Context, input Request) (Response, error) {
	if c == nil || parent == nil {
		return Response{}, ErrExternalRequestFailed
	}
	c.mu.Lock()
	c.requests++
	requestNumber := c.requests
	c.mu.Unlock()
	if requestNumber > maxRequestsPerRun {
		return Response{}, ErrExternalRequestFailed
	}

	requestContext, cancel := context.WithTimeout(parent, requestDeadline)
	defer cancel()

	normalizedOrigin, err := NormalizeOrigin(input.Origin)
	if err != nil {
		return Response{}, ErrOriginNotAllowed
	}
	grantedOrigin, ok := c.origins[normalizedOrigin]
	if !ok {
		return Response{}, ErrOriginNotAllowed
	}
	if err := validateRequest(input); err != nil {
		return Response{}, ErrExternalRequestFailed
	}

	addresses, err := c.resolver.LookupNetIP(requestContext, "ip", grantedOrigin.host+".")
	if err != nil || len(addresses) == 0 {
		return Response{}, ErrExternalRequestFailed
	}
	checked := make([]netip.Addr, 0, len(addresses))
	seen := make(map[netip.Addr]struct{}, len(addresses))
	for _, address := range addresses {
		if !isPublicUnicast(address) {
			return Response{}, ErrOriginNotAllowed
		}
		address = address.Unmap()
		if _, found := seen[address]; found {
			continue
		}
		seen[address] = struct{}{}
		checked = append(checked, address)
	}

	requestURL, err := buildRequestURL(grantedOrigin, input.Path)
	if err != nil {
		return Response{}, ErrExternalRequestFailed
	}
	var body io.Reader
	if input.Body != "" {
		body = strings.NewReader(input.Body)
	}
	request, err := http.NewRequestWithContext(requestContext, input.Method, requestURL.String(), body)
	if err != nil {
		return Response{}, ErrExternalRequestFailed
	}
	for name, value := range input.Headers {
		request.Header.Set(requestHeaderNames[strings.ToLower(name)], value)
	}
	request.Close = true

	dial := c.dial
	transport := &http.Transport{
		Proxy:                  nil,
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxResponseHeaderBytes: maxResponseHeaderSize,
		TLSClientConfig:        c.tlsConfig(),
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var lastErr error
			for _, address := range checked {
				conn, dialErr := dial(ctx, network, net.JoinHostPort(address.String(), grantedOrigin.port))
				if dialErr == nil {
					return conn, nil
				}
				lastErr = dialErr
				if ctx.Err() != nil {
					break
				}
			}
			if lastErr == nil {
				lastErr = errors.New("no checked address")
			}
			return nil, lastErr
		},
	}
	defer transport.CloseIdleConnections()
	httpClient := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return Response{}, ErrExternalRequestFailed
	}
	defer response.Body.Close()
	if isRedirectStatus(response.StatusCode) {
		return Response{}, ErrExternalRequestFailed
	}
	if response.ContentLength > maxResponseBodyBytes {
		return Response{}, ErrExternalRequestFailed
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBodyBytes+1))
	if err != nil || len(responseBody) > maxResponseBodyBytes || !utf8.Valid(responseBody) {
		return Response{}, ErrExternalRequestFailed
	}
	responseHeaders, err := filteredResponseHeaders(response.Header)
	if err != nil {
		return Response{}, ErrExternalRequestFailed
	}
	return Response{Status: response.StatusCode, Headers: responseHeaders, Body: string(responseBody)}, nil
}

func (c *Client) tlsConfig() *tls.Config {
	if c.tls == nil {
		return &tls.Config{MinVersion: tls.VersionTLS12}
	}
	config := c.tls.Clone()
	if config.MinVersion < tls.VersionTLS12 {
		config.MinVersion = tls.VersionTLS12
	}
	return config
}

func validateRequest(input Request) error {
	switch input.Method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return ErrExternalRequestFailed
	}
	if _, err := validatePath(input.Path); err != nil {
		return ErrExternalRequestFailed
	}
	if len(input.Headers) > 16 {
		return ErrExternalRequestFailed
	}
	seen := make(map[string]struct{}, len(input.Headers))
	for name, value := range input.Headers {
		canonical, ok := requestHeaderNames[strings.ToLower(name)]
		if !ok || !utf8.ValidString(value) || len(value) > maxHeaderValueBytes || strings.ContainsAny(value, "\r\n") || containsHeaderControl(value) {
			return ErrExternalRequestFailed
		}
		if _, duplicate := seen[canonical]; duplicate {
			return ErrExternalRequestFailed
		}
		seen[canonical] = struct{}{}
	}
	if !utf8.ValidString(input.Body) || len(input.Body) > maxRequestBodyBytes {
		return ErrExternalRequestFailed
	}
	return nil
}

func validatePath(value string) (*url.URL, error) {
	if value == "" || value[0] != '/' || strings.HasPrefix(value, "//") || strings.ContainsAny(value, "\\#") {
		return nil, ErrExternalRequestFailed
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed == nil || parsed.IsAbs() || parsed.Opaque != "" || parsed.Host != "" || parsed.Fragment != "" ||
		!strings.HasPrefix(parsed.Path, "/") || strings.HasPrefix(parsed.Path, "//") || strings.Contains(parsed.Path, "\\") {
		return nil, ErrExternalRequestFailed
	}
	for _, segment := range strings.Split(parsed.Path, "/") {
		decoded := segment
		for i := 0; i <= len(segment); i++ {
			if decoded == "." || decoded == ".." || strings.ContainsAny(decoded, "/\\") {
				return nil, ErrExternalRequestFailed
			}
			next, decodeErr := url.PathUnescape(decoded)
			if decodeErr != nil || next == decoded {
				break
			}
			decoded = next
		}
	}
	return parsed, nil
}

func buildRequestURL(granted origin, path string) (*url.URL, error) {
	parsedPath, err := validatePath(path)
	if err != nil {
		return nil, ErrExternalRequestFailed
	}
	u := &url.URL{Scheme: "https", Host: granted.host, Path: parsedPath.Path, RawPath: parsedPath.RawPath, RawQuery: parsedPath.RawQuery}
	if granted.port != "443" {
		u.Host = net.JoinHostPort(granted.host, granted.port)
	}
	return u, nil
}

func filteredResponseHeaders(headers http.Header) (map[string]string, error) {
	filtered := make(map[string]string)
	valueCount := 0
	for _, name := range responseHeaderNames {
		values := headers.Values(name)
		if len(values) == 0 {
			continue
		}
		valueCount += len(values)
		if valueCount > 16 {
			return nil, ErrExternalRequestFailed
		}
		for _, value := range values {
			if !utf8.ValidString(value) || len(value) > maxHeaderValueBytes {
				return nil, ErrExternalRequestFailed
			}
		}
		joined := strings.Join(values, ", ")
		if len(joined) > maxHeaderValueBytes {
			return nil, ErrExternalRequestFailed
		}
		filtered[name] = joined
	}
	return filtered, nil
}

func containsHeaderControl(value string) bool {
	for i := 0; i < len(value); i++ {
		char := value[i]
		if (char < 0x20 && char != '\t') || char == 0x7f {
			return true
		}
	}
	return false
}

func isRedirectStatus(status int) bool {
	return status >= 300 && status <= 399 && status != http.StatusNotModified
}

func validDNSName(host string) bool {
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "[]:%") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := 0; i < len(label); i++ {
			char := label[i]
			if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' {
				return false
			}
		}
	}
	return true
}

func parseNormalizedOrigin(value string) (origin, error) {
	u, err := url.Parse(value)
	if err != nil || u == nil {
		return origin{}, ErrOriginNotAllowed
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "443"
	}
	return origin{host: host, port: port}, nil
}

func isPublicUnicast(address netip.Addr) bool {
	if !address.IsValid() || address.Zone() != "" {
		return false
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() || address.IsMulticast() || address.IsUnspecified() {
		return false
	}
	if address.Is4() {
		for _, prefix := range blockedIPv4Prefixes {
			if prefix.Contains(address) {
				return false
			}
		}
		return true
	}
	assigned := false
	for _, prefix := range assignedIPv6Prefixes {
		if prefix.Contains(address) {
			assigned = true
			break
		}
	}
	if !assigned {
		return false
	}
	for _, prefix := range blockedIPv6Prefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func mustPrefixes(values ...string) []netip.Prefix {
	prefixes := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		prefixes = append(prefixes, netip.MustParsePrefix(value))
	}
	return prefixes
}
