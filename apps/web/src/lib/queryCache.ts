import type { QueryClient, QueryFilters } from '@tanstack/react-query';

/**
 * Removes the queries matching `filters` from the cache, but each one only once no mounted
 * component still observes it. Used for data that no longer exists on the server (a deleted
 * document).
 *
 * Why not `removeQueries` right away: an observer still mounted at that moment (the detail page
 * re-renders once more before the route change unmounts it) gets a fresh, empty entry back on
 * its next render and fetches it at once. That request 404s, and the default retries repeat it.
 * Removing them later still matters: otherwise a Back press to the deleted document would briefly
 * show the stale cached copy.
 */
export function removeQueriesWhenUnobserved(queryClient: QueryClient, filters: QueryFilters) {
  const cache = queryClient.getQueryCache();
  const sweep = () => {
    for (const q of cache.findAll(filters)) {
      if (q.getObserversCount() === 0) cache.remove(q);
    }
    return cache.findAll(filters).length === 0;
  };
  if (sweep()) return;
  const unsubscribe = cache.subscribe((event) => {
    if (event.type === 'observerRemoved' && sweep()) unsubscribe();
  });
}
