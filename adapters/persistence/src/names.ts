import { PersistenceError } from "./errors.js";

const featureIdPattern = /^F-\d{3,}$/u;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const featureDirectoryPattern = /^(F-\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)$/u;

export const FEATURE_SLUG_MAX_LENGTH = 80;

export interface FeatureDirectoryParts {
  readonly featureId: string;
  readonly slug: string;
}

export function isFeatureId(value: unknown): value is string {
  return typeof value === "string" && featureIdPattern.test(value);
}

export function assertFeatureId(value: unknown): asserts value is string {
  if (!isFeatureId(value)) {
    throw new PersistenceError(
      "INVALID_FEATURE_ID",
      "Feature ID must match F- followed by at least three digits.",
    );
  }
}

export function sanitizeFeatureSlug(value: string): string {
  if (typeof value !== "string") {
    throw new PersistenceError("INVALID_SLUG", "Feature slug must be a string.");
  }

  const slug = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, FEATURE_SLUG_MAX_LENGTH)
    .replace(/-+$/u, "");

  if (slug.length === 0) {
    throw new PersistenceError(
      "INVALID_SLUG",
      "Feature slug must contain at least one letter or digit.",
    );
  }

  return slug;
}

export function isCanonicalFeatureSlug(value: unknown): value is string {
  if (typeof value !== "string" || !slugPattern.test(value) || value.length > FEATURE_SLUG_MAX_LENGTH) {
    return false;
  }

  try {
    return sanitizeFeatureSlug(value) === value;
  } catch {
    return false;
  }
}

export function formatFeatureDirectoryName(featureId: string, slug: string): string {
  assertFeatureId(featureId);
  const canonicalSlug = sanitizeFeatureSlug(slug);
  return `${featureId}-${canonicalSlug}`;
}

export function featureDirectoryName(featureId: string, slug: string): string {
  return formatFeatureDirectoryName(featureId, slug);
}

export function parseFeatureDirectoryName(
  directoryName: string,
): FeatureDirectoryParts | undefined {
  const match = featureDirectoryPattern.exec(directoryName);
  const featureId = match?.[1];
  const slug = match?.[2];

  if (featureId === undefined || slug === undefined || !isCanonicalFeatureSlug(slug)) {
    return undefined;
  }

  return { featureId, slug };
}
