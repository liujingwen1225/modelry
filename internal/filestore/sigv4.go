package filestore

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

const (
	sigV4Algorithm     = "AWS4-HMAC-SHA256"
	emptyPayloadSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	sigV4DateFormat    = "20060102"
	sigV4TimeFormat    = "20060102T150405Z"
)

// sigV4Signer 计算 AWS Signature Version 4；它只在内存中使用凭据。
type sigV4Signer struct {
	accessKey    string
	secretKey    string
	sessionToken string
	region       string
	service      string
}

// sign 为 request 设置 SigV4 头。payloadHash 为空表示不使用 x-amz-content-sha256 头，
// 此时 canonical request 仍使用空载荷哈希（AWS 官方测试向量场景）。
func (signer sigV4Signer) sign(request *http.Request, payloadHash string, now time.Time) error {
	canonical, signedHeaders, amzDate, err := signer.canonicalRequest(request, payloadHash, now)
	if err != nil {
		return err
	}
	scope := strings.Join([]string{now.UTC().Format(sigV4DateFormat), signer.region, signer.service, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{
		sigV4Algorithm,
		amzDate,
		scope,
		hexSHA256([]byte(canonical)),
	}, "\n")
	signature := hex.EncodeToString(hmacSHA256(signingKey(signer.secretKey, now.UTC().Format(sigV4DateFormat), signer.region, signer.service), []byte(stringToSign)))
	request.Header.Set("Authorization", fmt.Sprintf("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		sigV4Algorithm, signer.accessKey, scope, strings.Join(signedHeaders, ";"), signature))
	return nil
}

// canonicalRequest 构造 SigV4 canonical request，并返回签名头集合。
func (signer sigV4Signer) canonicalRequest(request *http.Request, payloadHash string, now time.Time) (string, []string, string, error) {
	if request == nil || request.URL == nil || signer.accessKey == "" || signer.secretKey == "" || signer.region == "" || signer.service == "" {
		return "", nil, "", ErrInvalidArgument
	}
	if request.Header == nil {
		request.Header = make(http.Header)
	}
	amzDate := now.UTC().Format(sigV4TimeFormat)
	request.Header.Set("X-Amz-Date", amzDate)
	signedHeaders := []string{"host", "x-amz-date"}
	if payloadHash != "" {
		request.Header.Set("X-Amz-Content-Sha256", payloadHash)
		signedHeaders = append(signedHeaders, "x-amz-content-sha256")
	} else {
		request.Header.Del("X-Amz-Content-Sha256")
	}
	if signer.sessionToken != "" {
		request.Header.Set("X-Amz-Security-Token", signer.sessionToken)
		signedHeaders = append(signedHeaders, "x-amz-security-token")
	}
	sort.Strings(signedHeaders)

	canonicalHeaders := make([]string, 0, len(signedHeaders))
	for _, name := range signedHeaders {
		value := ""
		if name == "host" {
			value = request.Host
			if value == "" {
				value = request.URL.Host
			}
		} else {
			value = request.Header.Get(http.CanonicalHeaderKey(name))
		}
		canonicalHeaders = append(canonicalHeaders, name+":"+canonicalHeaderValue(value))
	}
	canonicalPayload := payloadHash
	if canonicalPayload == "" {
		canonicalPayload = emptyPayloadSHA256
	}
	canonical := strings.Join([]string{
		request.Method,
		canonicalURI(request.URL.EscapedPath()),
		canonicalQuery(request.URL.Query()),
		strings.Join(canonicalHeaders, "\n") + "\n",
		strings.Join(signedHeaders, ";"),
		canonicalPayload,
	}, "\n")
	return canonical, signedHeaders, amzDate, nil
}

// canonicalHeaderValue 按 SigV4 要求折叠连续空白并去掉首尾空白。
func canonicalHeaderValue(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

// canonicalURI 对每个路径段做 RFC3986 编码；S3 不接受二次编码。
func canonicalURI(escapedPath string) string {
	if escapedPath == "" {
		return "/"
	}
	segments := strings.Split(escapedPath, "/")
	encoded := make([]string, 0, len(segments))
	for _, segment := range segments {
		decoded, err := decodePathSegment(segment)
		if err != nil {
			decoded = segment
		}
		encoded = append(encoded, uriEncode(decoded, true))
	}
	result := strings.Join(encoded, "/")
	if !strings.HasPrefix(result, "/") {
		result = "/" + result
	}
	return result
}

// canonicalQuery 按键与值分别编码后排序。
func canonicalQuery(values map[string][]string) string {
	type pair struct{ key, value string }
	pairs := make([]pair, 0)
	for key, list := range values {
		encodedKey := uriEncode(key, true)
		if len(list) == 0 {
			pairs = append(pairs, pair{key: encodedKey, value: ""})
			continue
		}
		for _, value := range list {
			pairs = append(pairs, pair{key: encodedKey, value: uriEncode(value, true)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].key == pairs[j].key {
			return pairs[i].value < pairs[j].value
		}
		return pairs[i].key < pairs[j].key
	})
	parts := make([]string, 0, len(pairs))
	for _, item := range pairs {
		parts = append(parts, item.key+"="+item.value)
	}
	return strings.Join(parts, "&")
}

// uriEncode 实现 RFC3986 非保留字符集合。
func uriEncode(value string, encodeSlash bool) string {
	var builder strings.Builder
	for i := 0; i < len(value); i++ {
		char := value[i]
		switch {
		case char >= 'A' && char <= 'Z', char >= 'a' && char <= 'z', char >= '0' && char <= '9',
			char == '-', char == '_', char == '.', char == '~':
			builder.WriteByte(char)
		case char == '/' && !encodeSlash:
			builder.WriteByte(char)
		default:
			builder.WriteString(fmt.Sprintf("%%%02X", char))
		}
	}
	return builder.String()
}

func decodePathSegment(segment string) (string, error) {
	if !strings.Contains(segment, "%") {
		return segment, nil
	}
	var builder strings.Builder
	for i := 0; i < len(segment); i++ {
		if segment[i] != '%' {
			builder.WriteByte(segment[i])
			continue
		}
		if i+2 >= len(segment) {
			return "", ErrInvalidArgument
		}
		value, err := hex.DecodeString(segment[i+1 : i+3])
		if err != nil {
			return "", err
		}
		builder.WriteByte(value[0])
		i += 2
	}
	return builder.String(), nil
}

func sha256Sum(value []byte) []byte {
	sum := sha256.Sum256(value)
	return sum[:]
}

func hexSHA256(value []byte) string { return hex.EncodeToString(sha256Sum(value)) }

func hmacSHA256(key, value []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(value)
	return mac.Sum(nil)
}

func signingKey(secret, date, region, service string) []byte {
	dateKey := hmacSHA256([]byte("AWS4"+secret), []byte(date))
	regionKey := hmacSHA256(dateKey, []byte(region))
	serviceKey := hmacSHA256(regionKey, []byte(service))
	return hmacSHA256(serviceKey, []byte("aws4_request"))
}
