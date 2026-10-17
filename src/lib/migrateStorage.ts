/**
 * Storage keys from before the rename (Navify → Musify): `navify.*` becomes `musify.*`, once. Imported
 * first in main.tsx, before any store reads localStorage.
 */
const OLD = "navify.";
const NEW = "musify.";

try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key?.includes(OLD)) continue;
    const renamed = key.replaceAll(OLD, NEW);
    const value = localStorage.getItem(key);
    if (value !== null && localStorage.getItem(renamed) === null) localStorage.setItem(renamed, value);
    localStorage.removeItem(key);
  }
} catch {
  // No storage (private mode, tests): nothing to migrate.
}

export {};
