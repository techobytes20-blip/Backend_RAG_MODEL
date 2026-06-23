import crypto from 'crypto';

class CacheManager {
  constructor(maxSize = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.activeRequests = new Map();
  }

  generateHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Returns a cached value or executes the fetch function, caching its result.
   * Also prevents identical concurrent requests from running twice.
   * 
   * @param {string} key - The string key to hash (e.g., user question)
   * @param {Function} fetchFunction - Async function returning the data to cache
   * @returns {Promise<any>}
   */
  async getCachedOrFetch(key, fetchFunction) {
    const hashKey = this.generateHash(key);

    // 1. Check LRU Cache
    if (this.cache.has(hashKey)) {
      console.log(`[Cache Hit] Serving response from memory.`);
      // Move to front (LRU behavior)
      const val = this.cache.get(hashKey);
      this.cache.delete(hashKey);
      this.cache.set(hashKey, val);
      return val;
    }

    // 2. Prevent duplicate concurrent requests
    if (this.activeRequests.has(hashKey)) {
      console.log(`[Queue] Duplicate request detected. Waiting for existing execution...`);
      return this.activeRequests.get(hashKey);
    }

    // 3. Execute request and track it
    const requestPromise = (async () => {
      try {
        const result = await fetchFunction();
        
        // Update LRU Cache
        if (this.cache.size >= this.maxSize) {
          const firstKey = this.cache.keys().next().value;
          this.cache.delete(firstKey);
        }
        this.cache.set(hashKey, result);
        
        return result;
      } finally {
        // Clean up the active request map whether it succeeded or failed
        this.activeRequests.delete(hashKey);
      }
    })();

    this.activeRequests.set(hashKey, requestPromise);
    return requestPromise;
  }
}

// Export a singleton instance
export const cacheManager = new CacheManager(1000);
