/** Resolve material usage defaults for image and video reference validation. */

/**
 * Treat missing usage and legacy pending usage as owned; retain explicit restrictions.
 * @param {unknown} value - Persisted material or historical snapshot usage.
 * @returns {string} The normalized usage value without updating the material.
 */
export function normalizeMaterialAuthorization(value) {
  const authorization = typeof value === 'string' ? value.trim() : ''
  return !authorization || authorization === '待确认' ? '自有' : authorization
}
