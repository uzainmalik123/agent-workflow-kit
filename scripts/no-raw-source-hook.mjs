const FORBIDDEN = /\.ts$/;

const record = new Set();

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (FORBIDDEN.test(resolved.url)) {
    throw new Error(`Raw TypeScript source was resolved at runtime: ${resolved.url} (imported as "${specifier}")`);
  }
  record.add(resolved.url);
  return resolved;
}

export function getRecordedResolutions() {
  return Array.from(record).sort();
}