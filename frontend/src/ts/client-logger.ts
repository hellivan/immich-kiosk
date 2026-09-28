/**
 * Client-side log aggregator and error collector.
 *
 * Intercepts console output and uncaught errors/rejections, batches them, and
 * ships them to the server (`POST /client-logs`) so they can be inspected via
 * the server's stdout logs. This is primarily intended for debugging devices
 * (e.g. smart displays, kiosk browsers) that don't expose devtools.
 *
 * This is entirely opt-in and gated by the `client_logging` server config
 * option (exposed to the frontend as `kioskData.clientLogging`). When
 * disabled, `initClientLogger` is a no-op.
 */

type ClientLogLevel = "debug" | "info" | "warn" | "error";

type ClientLogSource =
    | "console"
    | "window.onerror"
    | "unhandledrejection"
    | "resource"
    | "heartbeat"
    | "device-info";

interface ClientLogEntry {
    level: ClientLogLevel;
    message: string;
    source: ClientLogSource;
    stack?: string;
    url: string;
    timestamp: string;
}

// Non-standard Chromium API (performance.memory) used to snapshot JS heap
// usage. Not present in all browsers - must be feature-detected before use.
interface PerformanceMemory {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
}

// Non-standard Network Information API (navigator.connection), used to
// report the effective connection type/quality. Not present in all
// browsers - must be feature-detected before use.
interface NetworkInformation {
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
}

// Non-standard extras on Navigator that may or may not be present depending
// on browser/engine - all optional and must be feature-detected.
interface NavigatorWithExtras extends Navigator {
    deviceMemory?: number;
    connection?: NetworkInformation;
}

const CLIENT_LOGS_ENDPOINT = "/client-logs";

// Batch entries and flush periodically rather than sending one request per
// log line, to avoid flooding the server/network.
const FLUSH_INTERVAL_MS = 5000;

// Periodic heartbeat interval. Used to snapshot JS heap memory usage so that,
// on devices that silently freeze/crash (e.g. renderer OOM-killed on a Nest
// Hub) without ever throwing a catchable error, the last few heartbeats
// before the gap can reveal whether memory was climbing toward a crash.
const HEARTBEAT_INTERVAL_MS = 30000;

// Safety valve so a runaway logging loop can't grow memory/network usage
// unbounded before the next flush.
const MAX_BUFFER_SIZE = 200;

let enabled = false;
let deviceID = "";
let clientName = "";
let buffer: ClientLogEntry[] = [];
let flushTimerId: number | null = null;
let heartbeatTimerId: number | null = null;

// Tracks whether performance.memory is usable on this device. `null` means
// "not yet determined" - the availability notice is only ever logged once,
// the first time recordHeartbeat() runs, to avoid repeating it every 30s.
let memoryStatsAvailable: boolean | null = null;

// Keep references to the original console methods so we can still print to
// the (possibly non-existent) local console as normal, in addition to
// forwarding entries to the server.
const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
};

/**
 * Best-effort conversion of arbitrary console arguments into a single string.
 */
function formatArgs(args: unknown[]): string {
    return args
        .map((arg) => {
            if (typeof arg === "string") return arg;
            if (arg instanceof Error) return arg.stack || arg.message;
            try {
                return JSON.stringify(arg);
            } catch {
                return String(arg);
            }
        })
        .join(" ");
}

function enqueue(entry: ClientLogEntry): void {
    if (!enabled) return;

    buffer.push(entry);

    if (buffer.length >= MAX_BUFFER_SIZE) {
        flush();
    }
}

/**
 * Returns the current page URL as-is. Wrapped only because accessing
 * `window.location` is technically capable of throwing in exotic/sandboxed
 * embedders - not for redaction purposes (this is a homelab debug tool, not
 * a multi-tenant service, so the raw URL - including any query params - is
 * intentionally captured verbatim to maximize debugging info).
 */
function getCurrentUrl(): string {
    try {
        return window.location.href;
    } catch {
        return "";
    }
}

function record(
    level: ClientLogLevel,
    source: ClientLogSource,
    message: string,
    stack?: string,
): void {
    enqueue({
        level,
        source,
        message,
        stack,
        url: getCurrentUrl(),
        timestamp: new Date().toISOString(),
    });
}

/**
 * Sends the current buffer to the server. Uses `navigator.sendBeacon` when
 * available (particularly important on page unload, when a normal fetch may
 * be cancelled), falling back to `fetch` with `keepalive`.
 */
function flush(useBeacon = false): void {
    if (!enabled || buffer.length === 0) return;

    const entries = buffer;
    buffer = [];

    const payload = JSON.stringify({
        deviceID,
        clientName,
        entries,
    });

    try {
        if (
            useBeacon &&
            typeof navigator.sendBeacon === "function" &&
            navigator.sendBeacon(
                CLIENT_LOGS_ENDPOINT,
                new Blob([payload], { type: "application/json" }),
            )
        ) {
            return;
        }

        fetch(CLIENT_LOGS_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            keepalive: true,
        }).catch(() => {
            // Swallow network errors: logging must never itself crash or
            // spam the console with further errors.
        });
    } catch {
        // Ignore - nothing sensible to do if shipping logs itself fails.
    }
}

function patchConsole(): void {
    const levels: [keyof typeof originalConsole, ClientLogLevel][] = [
        ["log", "info"],
        ["info", "info"],
        ["warn", "warn"],
        ["error", "error"],
        ["debug", "debug"],
    ];

    for (const [method, level] of levels) {
        console[method] = (...args: unknown[]) => {
            originalConsole[method](...args);
            record(level, "console", formatArgs(args));
        };
    }
}

function registerGlobalErrorHandlers(): void {
    window.addEventListener("error", (event: ErrorEvent) => {
        // Resource load errors (e.g. broken image/script src) fire "error"
        // events too, but without message/error details.
        if (event.error instanceof Error) {
            record(
                "error",
                "window.onerror",
                event.error.message || event.message,
                event.error.stack,
            );
            return;
        }

        if (event.message) {
            record(
                "error",
                "window.onerror",
                `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
            );
            return;
        }

        const target = event.target as HTMLElement | null;
        if (target && target !== (window as unknown as HTMLElement)) {
            const src =
                target.getAttribute("src") || target.getAttribute("href");
            if (src) {
                record("error", "resource", `Failed to load resource: ${src}`);
            }
        }
    });

    window.addEventListener(
        "unhandledrejection",
        (event: PromiseRejectionEvent) => {
            const reason = event.reason;
            const message =
                reason instanceof Error ? reason.message : formatArgs([reason]);
            const stack = reason instanceof Error ? reason.stack : undefined;
            record("error", "unhandledrejection", message, stack);
        },
    );
}

function registerFlushTriggers(): void {
    flushTimerId = window.setInterval(() => flush(), FLUSH_INTERVAL_MS);

    // Flush proactively when the page is about to be hidden/unloaded so we
    // don't lose the last batch of entries.
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            flush(true);
        }
    });
    window.addEventListener("pagehide", () => flush(true));
}

/**
 * Attempts to read a single field value and, if successful and non-empty,
 * appends `key=value` to the given fields array. Each field is independently
 * guarded: a throwing/unsupported API for one field can never prevent any
 * other field from being collected, and never prevents the calling function
 * from producing a log entry.
 */
function tryAddField(
    fields: string[],
    key: string,
    getValue: () => unknown,
): void {
    try {
        const value = getValue();
        if (value !== undefined && value !== null && value !== "") {
            fields.push(`${key}=${value}`);
        }
    } catch {
        // Ignore - this field simply won't be included, everything else
        // continues unaffected.
    }
}

/**
 * Attempts to read and return a value, independently of any other field
 * collection - returns `undefined` on any failure rather than throwing.
 */
function tryGet<T>(getValue: () => T): T | undefined {
    try {
        return getValue();
    } catch {
        return undefined;
    }
}

/**
 * Records a single, one-time entry describing the device/browser engine and
 * general environment stats (user agent, platform, screen, CPU/memory
 * hints, network/connection info, timezone, etc). This gives server-side
 * logs enough context to know *what* device a stream of heartbeats/errors is
 * coming from, without having to cross-reference the opaque deviceID hash.
 *
 * Every field is collected independently via `tryAddField` - a
 * missing/throwing API on a given browser/engine only omits that one field,
 * everything else that *is* available is still captured and sent.
 */
function recordDeviceInfo(): void {
    const nav = navigator as NavigatorWithExtras;
    const fields: string[] = [];

    tryAddField(fields, "userAgent", () => `"${nav.userAgent}"`);
    tryAddField(fields, "vendor", () => nav.vendor);
    tryAddField(fields, "platform", () => nav.platform);
    tryAddField(fields, "language", () => nav.language);
    tryAddField(fields, "languages", () => nav.languages?.join(","));
    tryAddField(fields, "cookieEnabled", () => nav.cookieEnabled);
    tryAddField(fields, "onLine", () => nav.onLine);
    tryAddField(fields, "webdriver", () => nav.webdriver);
    tryAddField(fields, "hardwareConcurrency", () => nav.hardwareConcurrency);
    tryAddField(fields, "deviceMemoryGB", () => nav.deviceMemory);
    tryAddField(fields, "maxTouchPoints", () => nav.maxTouchPoints);
    tryAddField(
        fields,
        "screen",
        () =>
            `${window.screen?.width}x${window.screen?.height}` +
            `@${window.screen?.colorDepth}bit`,
    );
    tryAddField(
        fields,
        "screenAvail",
        () => `${window.screen?.availWidth}x${window.screen?.availHeight}`,
    );
    tryAddField(
        fields,
        "viewport",
        () => `${window.innerWidth}x${window.innerHeight}`,
    );
    tryAddField(fields, "pixelRatio", () => window.devicePixelRatio);
    tryAddField(fields, "orientation", () => window.screen?.orientation?.type);
    tryAddField(
        fields,
        "timezone",
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    tryAddField(fields, "connectionType", () => nav.connection?.effectiveType);
    tryAddField(
        fields,
        "connectionDownlinkMbps",
        () => nav.connection?.downlink,
    );
    tryAddField(fields, "connectionRttMs", () => nav.connection?.rtt);
    tryAddField(fields, "connectionSaveData", () => nav.connection?.saveData);

    const message =
        fields.length > 0
            ? `device info ${fields.join(" ")}`
            : "device info unavailable (no supported navigator/screen APIs)";

    record("info", "device-info", message);
}

/**
 * Records a single heartbeat entry. Includes as many cheap stats as the
 * device/browser exposes (uptime, tab visibility, JS heap memory when
 * available via the non-standard Chromium `performance.memory` API, etc).
 *
 * Every stat is collected independently via `tryAddField` - a
 * throwing/unsupported API for one stat only omits that one stat, it never
 * prevents the heartbeat entry itself from being sent, and never stops
 * future heartbeats from firing.
 */
function recordHeartbeat(): void {
    const fields: string[] = [];

    tryAddField(fields, "uptimeSeconds", () =>
        Math.round(performance.now() / 1000),
    );
    tryAddField(fields, "visibility", () => document.visibilityState);

    const memory = tryGet(
        () =>
            (performance as Performance & { memory?: PerformanceMemory })
                .memory,
    );
    if (memory) {
        tryAddField(fields, "usedJSHeapSize", () => memory.usedJSHeapSize);
        tryAddField(fields, "totalJSHeapSize", () => memory.totalJSHeapSize);
        tryAddField(fields, "jsHeapSizeLimit", () => memory.jsHeapSizeLimit);
    }

    if (memoryStatsAvailable === null) {
        memoryStatsAvailable = Boolean(memory);
        if (!memoryStatsAvailable) {
            record(
                "info",
                "heartbeat",
                "heartbeat memory stats unavailable on this device (performance.memory not supported) - continuing with plain heartbeats",
            );
        }
    }

    record("debug", "heartbeat", `heartbeat ${fields.join(" ")}`.trim());
}

/**
 * Starts the periodic heartbeat, recording an immediate baseline entry on
 * page load and then one every HEARTBEAT_INTERVAL_MS.
 *
 * The initial call and the interval setup are guarded independently: if
 * `setInterval` itself throws in some unusual embedder, the baseline
 * heartbeat above has still been recorded, and vice versa.
 */
function registerHeartbeat(): void {
    try {
        recordHeartbeat();
    } catch {
        // recordHeartbeat() already guards each individual stat via
        // tryAddField; this is a last-resort net around the initial call
        // specifically so it can't prevent the interval below from starting.
    }

    try {
        heartbeatTimerId = window.setInterval(
            recordHeartbeat,
            HEARTBEAT_INTERVAL_MS,
        );
    } catch {
        // If the interval can't be set up, the baseline heartbeat above was
        // still recorded, and the rest of the logger continues unaffected.
    }
}

/**
 * Initializes the client-side log aggregator/error collector.
 *
 * Each setup step is independently guarded so that a failure in any one of
 * them (e.g. an unsupported API throwing during setup) can't prevent the
 * others from initializing - the logger degrades gracefully rather than
 * failing all-or-nothing.
 *
 * @param clientLoggingEnabled Whether client logging is enabled server-side.
 * @param deviceIdentifier Unique identifier for this device/browser instance.
 * @param name Optional friendly client name (as used elsewhere in Kiosk).
 */
export function initClientLogger(
    clientLoggingEnabled: boolean,
    deviceIdentifier: string,
    name?: string,
): void {
    if (!clientLoggingEnabled || enabled) return;

    enabled = true;
    deviceID = deviceIdentifier;
    clientName = name || "";

    const steps: [string, () => void][] = [
        ["patchConsole", patchConsole],
        ["registerGlobalErrorHandlers", registerGlobalErrorHandlers],
        ["registerFlushTriggers", registerFlushTriggers],
        ["recordDeviceInfo", recordDeviceInfo],
        ["registerHeartbeat", registerHeartbeat],
    ];

    for (const [name, step] of steps) {
        try {
            step();
        } catch (error) {
            // A single failed setup step should never prevent the rest of
            // the logger from initializing.
            originalConsole.warn(
                `Client logger: failed to initialize "${name}"`,
                error,
            );
        }
    }

    originalConsole.debug("Client logging enabled - forwarding to server");
}

/**
 * Stops the client logger and flushes any remaining buffered entries.
 * Exposed mainly for completeness/testability.
 */
export function stopClientLogger(): void {
    if (!enabled) return;

    if (flushTimerId !== null) {
        window.clearInterval(flushTimerId);
        flushTimerId = null;
    }

    if (heartbeatTimerId !== null) {
        window.clearInterval(heartbeatTimerId);
        heartbeatTimerId = null;
    }

    memoryStatsAvailable = null;

    flush(true);
    enabled = false;
}
