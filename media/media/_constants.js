// =============================================================================
// Shared constants for the Voice & Media Engineer module.
//
// Centralising the MIME allowlists here keeps `image.js`/`video.js`/`voice.js`
// thin and makes it easy for the WhatsApp Client Engineer to know what we'll
// accept before they forward a message.
//
// Folders: see `media/_paths.js` — they live alongside the project root so the
// server-side paths can be referenced from any adapter / dispatcher.
// =============================================================================

/** Image MIME types we accept. Maps to file extension for disk write. */
export const IMAGE_MIME_TYPES = Object.freeze({
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
});

/** Video MIME types we accept. Size-limited per `VIDEO_MAX_BYTES`. */
export const VIDEO_MIME_TYPES = Object.freeze({
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/3gpp": ".3gp",
});

/** Voice notes — WhatsApp typically delivers `audio/ogg; codecs=opus`. */
export const VOICE_MIME_TYPES = Object.freeze({
  "audio/ogg": ".ogg",
  "audio/ogg; codecs=opus": ".ogg",
  "audio/opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".webm",
});

/** Hard cap on inbound video payloads — fail loudly rather than fill the disk. */
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/** Hard cap on inbound image payloads. WhatsApp caps at ~16 MB on send. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/** Hard cap on inbound voice payloads. */
export const VOICE_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
