/**
 * Normalizes a query object into a deterministic canonical cache key.
 * This guarantees that structurally identical queries generate the same key,
 * regardless of the order the parameters were defined.
 * @param {Object} query - The parsed query/filter object
 * @returns {string} The canonical cache key
 */
export function normalizeQuery(query) {
    if (!query) return 'all';
    
    // Extract keys and sort them alphabetically
    const keys = Object.keys(query).sort();
    
    if (keys.length === 0) return 'all';
    
    const parts = keys.map(key => {
        let val = query[key];
        // Standardize string values
        if (typeof val === 'string') {
            val = val.trim().toLowerCase();
        }
        return `${key}=${val}`;
    });
    
    return parts.join('&');
}
