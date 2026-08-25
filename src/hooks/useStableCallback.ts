import { useCallback, useEffect, useRef } from 'react'

/**
 * Returns a referentially stable function that always invokes the latest
 * callback passed to this hook. Memoized children (React.memo) can therefore
 * receive stable handler props without freezing stale closures over old
 * state — each call reads the implementation from the current render.
 */
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  })
  return useCallback((...args: Args) => callbackRef.current(...args), [])
}
