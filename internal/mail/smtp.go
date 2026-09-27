package mail

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// SMTPSender 使用隐式 TLS 或 STARTTLS 发送邮件；它拒绝在未加密连接上发送凭据。
type SMTPSender struct{}

func (SMTPSender) Send(ctx context.Context, config Config, credentials Credentials, message Message) error {
	address := net.JoinHostPort(config.Host, fmt.Sprint(config.Port))
	dialer := &net.Dialer{Timeout: DialTimeout}
	var connection net.Conn
	var err error
	if config.Security == SecurityPlaintext && !isLoopbackHost(config.Host) {
		return fmt.Errorf("%w: plaintext SMTP is only accepted for a loopback host", ErrInvalidArgument)
	}
	tlsConfig := &tls.Config{ServerName: config.Host, MinVersion: tls.VersionTLS12}
	if config.Security == SecurityTLS {
		connection, err = tls.DialWithDialer(dialer, "tcp", address, tlsConfig)
	} else {
		connection, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return fmt.Errorf("%w: connecting to the mail provider failed", ErrUnavailable)
	}
	defer connection.Close()
	deadline := time.Now().Add(DeliveryTimeout)
	if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
		deadline = value
	}
	_ = connection.SetDeadline(deadline)
	client, err := smtp.NewClient(connection, config.Host)
	if err != nil {
		return fmt.Errorf("%w: the mail provider did not accept a session", ErrUnavailable)
	}
	defer func() { _ = client.Close() }()
	if config.Security == SecurityStartTLS {
		if err := client.StartTLS(tlsConfig); err != nil {
			return fmt.Errorf("%w: the mail provider does not support STARTTLS", ErrUnavailable)
		}
	}
	if credentials.Username != "" {
		auth := smtp.PlainAuth("", credentials.Username, credentials.Password, config.Host)
		if err := client.Auth(auth); err != nil {
			return fmt.Errorf("%w: mail authentication failed", ErrCredentialUnavailable)
		}
	}
	if err := client.Mail(message.From); err != nil {
		return fmt.Errorf("%w: the sender address was rejected", ErrUnavailable)
	}
	if err := client.Rcpt(message.To); err != nil {
		return fmt.Errorf("%w: the recipient address was rejected", ErrUnavailable)
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("%w: the mail provider rejected the message", ErrUnavailable)
	}
	payload := composeMessage(message)
	if len(payload) > MaximumMessageBytes {
		_ = writer.Close()
		return fmt.Errorf("%w: the message exceeds the size limit", ErrInvalidArgument)
	}
	if _, err := writer.Write(payload); err != nil {
		_ = writer.Close()
		return fmt.Errorf("%w: writing the message failed", ErrUnavailable)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("%w: the mail provider rejected the message", ErrUnavailable)
	}
	_ = client.Quit()
	return nil
}

// composeMessage 生成只含纯文本正文的 RFC 5322 消息；所有头都经过 CR/LF 清洗。
func composeMessage(message Message) []byte {
	lines := []string{
		"From: " + sanitizeHeader(message.From),
		"To: " + sanitizeHeader(message.To),
		"Subject: " + sanitizeHeader(message.Subject),
		"Date: " + message.Date.UTC().Format(time.RFC1123Z),
		"Message-ID: " + sanitizeHeader(message.MessageID),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: 8bit",
		"",
	}
	body := strings.ReplaceAll(message.Body, "\r\n", "\n")
	body = strings.ReplaceAll(body, "\n", "\r\n")
	return []byte(strings.Join(lines, "\r\n") + body + "\r\n")
}

func sanitizeHeader(value string) string {
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	return strings.TrimSpace(value)
}

// isLoopbackHost 判断 SMTP 主机是否只在本机可达。
func isLoopbackHost(host string) bool {
	trimmed := strings.TrimSpace(strings.ToLower(host))
	if trimmed == "localhost" {
		return true
	}
	address := net.ParseIP(strings.Trim(trimmed, "[]"))
	return address != nil && address.IsLoopback()
}

var _ = errors.Is
