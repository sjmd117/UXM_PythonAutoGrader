"use client";

import { Dispatch, SetStateAction, useCallback, useMemo, useSyncExternalStore } from "react";

const STORAGE_UPDATE_EVENT = "uxm-grader-storage-update";
const memoryStore = new Map<string, string>();

export function readStoredValue<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const rawValue = window.localStorage.getItem(key) ?? memoryStore.get(key) ?? null;
    return rawValue === null ? fallback : (JSON.parse(rawValue) as T);
  } catch {
    const rawValue = memoryStore.get(key);
    return rawValue === undefined ? fallback : (JSON.parse(rawValue) as T);
  }
}

function subscribeToStorage(callback: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  window.addEventListener("storage", callback);
  window.addEventListener(STORAGE_UPDATE_EVENT, callback);

  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(STORAGE_UPDATE_EVENT, callback);
  };
}

export function useStoredState<T>(key: string, fallback: T): readonly [T, Dispatch<SetStateAction<T>>] {
  const fallbackSnapshot = useMemo(() => JSON.stringify(fallback), [fallback]);
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined") {
      return fallbackSnapshot;
    }

    try {
      return window.localStorage.getItem(key) ?? memoryStore.get(key) ?? fallbackSnapshot;
    } catch {
      return memoryStore.get(key) ?? fallbackSnapshot;
    }
  }, [fallbackSnapshot, key]);
  const storedSnapshot = useSyncExternalStore(subscribeToStorage, getSnapshot, () => fallbackSnapshot);
  const value = useMemo(() => {
    try {
      return JSON.parse(storedSnapshot) as T;
    } catch {
      return fallback;
    }
  }, [fallback, storedSnapshot]);
  const setStoredValue = useCallback<Dispatch<SetStateAction<T>>>(
    (nextValue) => {
      if (typeof window === "undefined") {
        return;
      }

      const currentValue = readStoredValue(key, fallback);
      const resolvedValue = nextValue instanceof Function ? nextValue(currentValue) : nextValue;
      writeStoredValue(key, resolvedValue);
    },
    [fallback, key],
  );

  return [value, setStoredValue] as const;
}

export function writeStoredValue<T>(key: string, value: T) {
  if (typeof window === "undefined") {
    return;
  }

  const nextSnapshot = JSON.stringify(value);
  memoryStore.set(key, nextSnapshot);

  try {
    window.localStorage.setItem(key, nextSnapshot);
  } catch {
    // If storage is unavailable, keep the in-memory UI working.
  }

  window.dispatchEvent(new Event(STORAGE_UPDATE_EVENT));
}
