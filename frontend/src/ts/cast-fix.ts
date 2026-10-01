/**
 * Google Cast (Chromecast) keep-alive fix.
 *
 * When Kiosk is cast directly to a Chromecast device (e.g. a Google Nest Hub)
 * using tools like `catt` (Cast All The Things) via the generic DashCast
 * receiver, Chromecast silently closes the session after roughly 10 minutes
 * of no media playback.
 *
 * This mirrors the fix used by the "ha-catt-fix" project for Home Assistant:
 * load the Cast Application Framework (CAF) receiver SDK and periodically
 * feed it a tiny dummy image "load" request so the receiver considers itself
 * active and never hits the idle timeout.
 *
 * This is a no-op unless Kiosk is actually running inside a Cast receiver
 * session (i.e. it is being cast via DashCast/catt), so it only does
 * anything when needed.
 */

// Minimal ambient typings for the parts of the Cast Application Framework
// (CAF) receiver SDK that are used here. The full SDK types are not
// published on npm, so only what we need is declared.
interface CastMediaInformation {
    contentId: string;
    contentType: string;
    streamType: string;
    metadata: unknown;
}

interface CastLoadRequestData {
    autoplay: boolean;
    media: CastMediaInformation;
    requestId: number;
}

interface CastPlayerManager {
    load: (request: CastLoadRequestData) => void;
}

interface CastReceiverOptions {
    disableIdleTimeout: boolean;
}

interface CastReceiverContext {
    getDeviceCapabilities: () => Record<string, unknown> | null;
    getPlayerManager: () => CastPlayerManager;
    addEventListener: (eventType: string, listener: () => void) => void;
    setApplicationState: (state: string) => void;
    start: (options: CastReceiverOptions) => void;
}

interface CastFramework {
    CastReceiverContext: { getInstance: () => CastReceiverContext };
    CastReceiverOptions: new () => CastReceiverOptions;
    messages: {
        LoadRequestData: new () => CastLoadRequestData;
        MediaInformation: new () => CastMediaInformation;
        GenericMediaMetadata: new () => { title: string };
        StreamType: { NONE: string };
    };
    system: { EventType: { READY: string } };
}

declare global {
    interface Window {
        cast?: { framework: CastFramework };
    }
}

const CAST_RECEIVER_FRAMEWORK_URL =
    "https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js";

// Google closes idle Cast sessions after ~10 minutes; refresh comfortably
// inside that window.
const DUMMY_MEDIA_INTERVAL_MS = 9 * 60 * 1000;

// Default dummy media image used to keep the receiver "active" when no
// custom URL is configured. It is never actually shown to the user.
const DEFAULT_DUMMY_MEDIA_CONTENT_ID =
    "https://cast.home-assistant.io/images/google-nest-hub.png";

let dummyMediaContentId = DEFAULT_DUMMY_MEDIA_CONTENT_ID;
let dummyMediaTimerId: number | null = null;

function loadScript(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.type = "text/javascript";
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${url}`));
        document.head.appendChild(script);
    });
}

function playDummyMedia(
    framework: CastFramework,
    playerManager: CastPlayerManager,
): void {
    const loadRequestData = new framework.messages.LoadRequestData();
    loadRequestData.autoplay = true;
    loadRequestData.media = new framework.messages.MediaInformation();
    loadRequestData.media.contentId = dummyMediaContentId;
    loadRequestData.media.contentType = "image/jpeg";
    loadRequestData.media.streamType = framework.messages.StreamType.NONE;
    loadRequestData.media.metadata =
        new framework.messages.GenericMediaMetadata();
    (loadRequestData.media.metadata as { title: string }).title =
        `Kiosk cast keep-alive ${new Date().toISOString()}`;
    loadRequestData.requestId = 0;

    playerManager.load(loadRequestData);

    dummyMediaTimerId = window.setTimeout(
        () => playDummyMedia(framework, playerManager),
        DUMMY_MEDIA_INTERVAL_MS,
    );
}

function startCastReceiver(framework: CastFramework): void {
    const castReceiverContext = framework.CastReceiverContext.getInstance();

    // getDeviceCapabilities() only returns a value when Kiosk is actually
    // running as the content of a Cast receiver session (e.g. cast via
    // catt/DashCast). In a normal browser tab this stays null, so we bail
    // out and do nothing.
    if (castReceiverContext.getDeviceCapabilities() === null) {
        return;
    }

    const playerManager = castReceiverContext.getPlayerManager();

    castReceiverContext.addEventListener(
        framework.system.EventType.READY,
        () => {
            castReceiverContext.setApplicationState("Kiosk cast ready");
            playDummyMedia(framework, playerManager);
        },
    );

    const options = new framework.CastReceiverOptions();
    options.disableIdleTimeout = true;

    castReceiverContext.start(options);
}

/**
 * Initialise the Chromecast keep-alive fix.
 *
 * Loads the CAF receiver SDK and, if Kiosk is running inside a Cast
 * receiver session, starts periodically loading dummy media so the cast
 * session is never closed due to inactivity - the "aborted after 10
 * minutes" issue seen when casting with catt/DashCast to devices such as a
 * Google Nest Hub.
 *
 * @param dummyImageUrl Optional URL of a small image to load periodically
 * as the "dummy" media keeping the session alive. Falls back to a bundled
 * default if omitted or invalid.
 */
export function initCastFix(dummyImageUrl?: string): void {
    if (dummyImageUrl) {
        try {
            // Validate the URL; keep the default on parse failure rather
            // than passing something the Cast receiver may choke on.
            dummyMediaContentId = new URL(dummyImageUrl).toString();
        } catch {
            console.error(
                `Invalid Cast fix dummy image URL "${dummyImageUrl}", falling back to default.`,
            );
        }
    }

    loadScript(CAST_RECEIVER_FRAMEWORK_URL)
        .then(() => {
            if (!window.cast) {
                throw new Error("Cast receiver framework did not load");
            }
            startCastReceiver(window.cast.framework);
        })
        .catch((error) => {
            console.error("Failed to initialise Cast keep-alive fix:", error);
        });
}

/** Stop the dummy media keep-alive loop, if running. */
export function stopCastFix(): void {
    if (dummyMediaTimerId !== null) {
        window.clearTimeout(dummyMediaTimerId);
        dummyMediaTimerId = null;
    }
}
