// Build version timestamp, formatted `YYYYMMDDHHMM` (Ajisai's scheme). It is
// stamped at deploy time by the Pages workflow (.github/workflows/pages.yml)
// and left empty here in source: a build-free local serve then falls back to
// the current time, exactly as Ajisai's build-timestamp label falls back to
// `new Date()` when the build define is absent. The timestamp is the
// build/release time; the runtime clock is only the dev fallback.
export const BUILD_TIMESTAMP = "";
