import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { removeQueriesWhenUnobserved } from './queryCache';

describe('removeQueriesWhenUnobserved', () => {
  it('removes unobserved queries at once', () => {
    const client = new QueryClient();
    client.setQueryData(['versions', 'a'], []);
    removeQueriesWhenUnobserved(client, { queryKey: ['versions', 'a'] });
    expect(client.getQueryCache().find({ queryKey: ['versions', 'a'] })).toBeUndefined();
  });

  it('waits for the last observer to leave, without refetching meanwhile', () => {
    const client = new QueryClient();
    const queryFn = vi.fn(() => Promise.resolve([]));
    client.setQueryData(['versions', 'a'], []);
    const observer = new QueryObserver(client, { queryKey: ['versions', 'a'], queryFn });
    const unsubscribe = observer.subscribe(() => {});
    queryFn.mockClear(); // ignore whatever subscribing did; only what follows matters

    removeQueriesWhenUnobserved(client, { queryKey: ['versions', 'a'] });
    expect(client.getQueryCache().find({ queryKey: ['versions', 'a'] })).toBeDefined();
    // The still-mounted component re-renders: it must not fetch the deleted resource.
    observer.setOptions({ queryKey: ['versions', 'a'], queryFn });
    expect(queryFn).not.toHaveBeenCalled();

    unsubscribe();
    expect(client.getQueryCache().find({ queryKey: ['versions', 'a'] })).toBeUndefined();
  });
});
