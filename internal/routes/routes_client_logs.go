package routes

import (
	"encoding/json"
	"net/http"
	"strings"

	"charm.land/log/v2"
	"github.com/labstack/echo/v5"

	"github.com/damongolding/immich-kiosk/internal/config"
)

// maxClientLogEntriesPerRequest caps the number of log entries processed in a
// single request to protect the server from overly large or malicious payloads.
const maxClientLogEntriesPerRequest = 200

// maxClientLogMessageLength caps how many characters of a client log message
// are logged to stdout to avoid huge payloads flooding the server logs.
const maxClientLogMessageLength = 4000

// clientLogEntry represents a single log/error entry sent from the client.
type clientLogEntry struct {
	// Level is the severity of the entry, e.g. "debug", "info", "warn", "error".
	Level string `json:"level"`
	// Message is the human readable log message.
	Message string `json:"message"`
	// Source identifies where the entry came from, e.g. "console", "window.onerror",
	// "unhandledrejection".
	Source string `json:"source"`
	// Stack contains an optional stack trace for errors.
	Stack string `json:"stack"`
	// URL is the page URL the entry originated from.
	URL string `json:"url"`
	// Timestamp is the client-reported time (RFC3339) the entry was captured.
	Timestamp string `json:"timestamp"`
}

// clientLogsPayload is the expected request body for the /client-logs endpoint.
type clientLogsPayload struct {
	// DeviceID identifies the device the entries originated from. Sent in the
	// body (rather than relying solely on a header) so the payload can be
	// delivered via navigator.sendBeacon, which does not support custom headers.
	DeviceID string `json:"deviceID"`
	// ClientName is the optional friendly name of the client.
	ClientName string           `json:"clientName"`
	Entries    []clientLogEntry `json:"entries"`
}

// ClientLogs returns an HTTP handler that accepts batched client-side log and
// error entries and writes them to the server's stdout logger. This allows
// debugging devices (e.g. Nest Hub, kiosk browsers) that don't expose devtools
// or console access.
//
// The endpoint is a no-op unless Kiosk.ClientLogging is enabled in config.
func ClientLogs(baseConfig *config.Config) echo.HandlerFunc {
	return func(c *echo.Context) error {
		if !baseConfig.Kiosk.ClientLogging {
			return c.NoContent(http.StatusNoContent)
		}

		var payload clientLogsPayload
		if err := json.NewDecoder(c.Request().Body).Decode(&payload); err != nil {
			log.Warn("client logs: failed to decode payload", "error", err)
			return c.NoContent(http.StatusBadRequest)
		}

		deviceID := payload.DeviceID
		if deviceID == "" {
			deviceID = c.Request().Header.Get("kiosk-device-id")
		}
		clientName := payload.ClientName
		if clientName == "" {
			clientName = c.QueryParams().Get("client")
		}

		entries := payload.Entries
		if len(entries) > maxClientLogEntriesPerRequest {
			entries = entries[:maxClientLogEntriesPerRequest]
		}

		for _, entry := range entries {
			logClientEntry(entry, deviceID, clientName)
		}

		return c.NoContent(http.StatusNoContent)
	}
}

// logClientEntry writes a single client log entry to stdout via the server logger,
// tagging it clearly as originating from the client and mapping its level to the
// closest matching server log level.
func logClientEntry(entry clientLogEntry, deviceID, clientName string) {
	message := entry.Message
	if len(message) > maxClientLogMessageLength {
		message = message[:maxClientLogMessageLength] + "…(truncated)"
	}

	fields := []any{
		"deviceID", deviceID,
		"client", clientName,
		"source", entry.Source,
		"url", entry.URL,
		"clientTime", entry.Timestamp,
	}

	if entry.Stack != "" {
		fields = append(fields, "stack", entry.Stack)
	}

	logMessage := "client: " + message

	switch strings.ToLower(entry.Level) {
	case "error":
		log.Error(logMessage, fields...)
	case "warn", "warning":
		log.Warn(logMessage, fields...)
	case "debug":
		log.Debug(logMessage, fields...)
	default:
		log.Info(logMessage, fields...)
	}
}
