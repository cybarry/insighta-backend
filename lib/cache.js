import { LRUCache } from 'lru-cache';

// Set up an in-memory cache to avoid external database dependencies as per requirements
const options = {
  max: 500, // Maximum number of items
  ttl: 1000 * 60 * 5, // 5 minutes TTL
};

export const queryCache = new LRUCache(options);

export function getCached(key) {
    return queryCache.get(key);
}

export function setCached(key, value) {
    queryCache.set(key, value);
}

export function clearCache() {
    queryCache.clear();
}
