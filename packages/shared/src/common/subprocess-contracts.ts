/**
 * Cross-process wiring constants shared by the kernel and the warden (ADR-0071 P1-10).
 *
 * These are the env-var names, project-config path, and capability identifiers the kernel
 * uses to configure or recognize the warden child. They are pure strings with no runtime
 * dependency, so they live in `@keel/shared` as the single source of truth; the warden
 * modules that own the corresponding behavior re-export them. Keeping them here means the
 * kernel does not import the warden's enforcement library just to know a config key.
 */

export const CREDENTIAL_PROXY_CONFIG_ENV = "KEEL_WARDEN_CREDENTIAL_PROXY_RULES";
export const CREDENTIAL_PROXY_PROJECT_CONFIG_PATH = ".keel/credential-proxy.json";

export const LIFECYCLE_MANIFEST_CONFIG_ENV = "KEEL_WARDEN_LIFECYCLE_MANIFEST";

export const INTERACTIVE_CONSOLE_CAPABILITY = "interactive-console:v1" as const;
export const INTERACTIVE_CONSOLE_TARGET_CAPABILITY_PREFIX = "interactive-console-target:" as const;
