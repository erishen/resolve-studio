"""
LRU Cache implementation with O(1) get/put, thread safety, unit tests, and usage example.
"""

from collections import OrderedDict
from threading import RLock
from typing import Any, Optional


class LRUCache:
    """
    Thread-safe LRU Cache with O(1) get and put operations.

    Uses OrderedDict for O(1) move-to-end and popitem operations,
    combined with an RLock for thread safety.
    """

    def __init__(self, capacity: int) -> None:
        if capacity <= 0:
            raise ValueError("Capacity must be a positive integer")
        self.capacity = capacity
        self._cache: OrderedDict[int, Any] = OrderedDict()
        self._lock = RLock()

    def get(self, key: int) -> Any:
        """
        Get value by key in O(1). Returns -1 if key not found.
        Moves accessed key to end (most recently used).
        """
        with self._lock:
            if key not in self._cache:
                return -1
            # Move to end to mark as most recently used
            self._cache.move_to_end(key)
            return self._cache[key]

    def put(self, key: int, value: Any) -> None:
        """
        Insert or update key-value pair in O(1).
        Evicts least recently used item when capacity is exceeded.
        """
        with self._lock:
            if key in self._cache:
                # Update existing key and move to end
                self._cache.move_to_end(key)
                self._cache[key] = value
            else:
                if len(self._cache) >= self.capacity:
                    # Evict least recently used (first item)
                    self._cache.popitem(last=False)
                self._cache[key] = value

    def size(self) -> int:
        """Return current number of items in cache."""
        with self._lock:
            return len(self._cache)

    def clear(self) -> None:
        """Remove all items from cache."""
        with self._lock:
            self._cache.clear()

    def __contains__(self, key: int) -> bool:
        with self._lock:
            return key in self._cache

    def __len__(self) -> int:
        return self.size()

    def __repr__(self) -> str:
        with self._lock:
            return f"LRUCache(capacity={self.capacity}, items={dict(self._cache)})"


# ---------------------------------------------------------------------------
# Unit Tests
# ---------------------------------------------------------------------------

import unittest
import threading
import time


class TestLRUCacheBasic(unittest.TestCase):
    """Normal operation tests."""

    def setUp(self):
        self.cache = LRUCache(capacity=3)

    def test_put_and_get(self):
        self.cache.put(1, 1)
        self.cache.put(2, 2)
        self.assertEqual(self.cache.get(1), 1)
        self.assertEqual(self.cache.get(2), 2)

    def test_get_missing_key(self):
        self.cache.put(1, 1)
        self.assertEqual(self.cache.get(2), -1)

    def test_overwrite_existing_key(self):
        self.cache.put(1, 1)
        self.cache.put(1, 10)
        self.assertEqual(self.cache.get(1), 10)

    def test_eviction_lru(self):
        """After capacity is reached, LRU item should be evicted."""
        self.cache.put(1, 1)
        self.cache.put(2, 2)
        self.cache.put(3, 3)
        # Access key 1 to make it recently used
        self.cache.get(1)
        # Insert key 4, should evict key 2 (LRU)
        self.cache.put(4, 4)
        self.assertEqual(self.cache.get(2), -1)  # evicted
        self.assertEqual(self.cache.get(1), 1)   # still present
        self.assertEqual(self.cache.get(3), 3)   # still present
        self.assertEqual(self.cache.get(4), 4)   # still present

    def test_eviction_without_access(self):
        """If no access, the oldest inserted item is evicted."""
        self.cache.put(1, 1)
        self.cache.put(2, 2)
        self.cache.put(3, 3)
        self.cache.put(4, 4)  # evicts key 1
        self.assertEqual(self.cache.get(1), -1)
        self.assertEqual(self.cache.get(2), 2)
        self.assertEqual(self.cache.get(3), 3)
        self.assertEqual(self.cache.get(4), 4)

    def test_size_and_contains(self):
        self.assertEqual(self.cache.size(), 0)
        self.cache.put(1, 1)
        self.assertEqual(self.cache.size(), 1)
        self.assertIn(1, self.cache)
        self.assertNotIn(2, self.cache)

    def test_clear(self):
        self.cache.put(1, 1)
        self.cache.put(2, 2)
        self.cache.clear()
        self.assertEqual(self.cache.size(), 0)
        self.assertEqual(self.cache.get(1), -1)


class TestLRUCacheBoundary(unittest.TestCase):
    """Boundary condition tests."""

    def test_capacity_one(self):
        cache = LRUCache(capacity=1)
        cache.put(1, 10)
        self.assertEqual(cache.get(1), 10)
        cache.put(2, 20)  # evicts key 1
        self.assertEqual(cache.get(1), -1)
        self.assertEqual(cache.get(2), 20)

    def test_invalid_capacity(self):
        with self.assertRaises(ValueError):
            LRUCache(capacity=0)
        with self.assertRaises(ValueError):
            LRUCache(capacity=-5)

    def test_single_item_cache(self):
        cache = LRUCache(capacity=1)
        cache.put(1, 1)
        cache.put(1, 1)  # overwrite same key
        self.assertEqual(cache.get(1), 1)
        self.assertEqual(cache.size(), 1)

    def test_large_capacity(self):
        cache = LRUCache(capacity=10000)
        for i in range(10000):
            cache.put(i, i * 2)
        self.assertEqual(cache.size(), 10000)
        self.assertEqual(cache.get(9999), 19998)

    def test_value_types(self):
        """Cache should handle various value types."""
        cache = LRUCache(capacity=3)
        cache.put(1, "string")
        cache.put(2, [1, 2, 3])
        cache.put(3, {"a": 1})
        self.assertEqual(cache.get(1), "string")
        self.assertEqual(cache.get(2), [1, 2, 3])
        self.assertEqual(cache.get(3), {"a": 1})

    def test_negative_key(self):
        """Keys can be negative integers."""
        cache = LRUCache(capacity=2)
        cache.put(-1, "neg")
        cache.put(-2, "neg2")
        self.assertEqual(cache.get(-1), "neg")
        self.assertEqual(cache.get(-2), "neg2")


class TestLRUCacheConcurrency(unittest.TestCase):
    """Concurrent access tests."""

    def test_concurrent_put_get(self):
        """Multiple threads putting and getting concurrently."""
        cache = LRUCache(capacity=100)
        num_threads = 10
        ops_per_thread = 100

        def worker(thread_id):
            for i in range(ops_per_thread):
                key = thread_id * ops_per_thread + i
                cache.put(key, key * 10)
                result = cache.get(key)
                # Some gets may return -1 if evicted, that's fine
                if result != -1:
                    self.assertEqual(result, key * 10)

        threads = [threading.Thread(target=worker, args=(tid,)) for tid in range(num_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # All puts should have succeeded
        self.assertEqual(cache.size(), min(num_threads * ops_per_thread, 100))

    def test_concurrent_same_key(self):
        """Multiple threads accessing the same key simultaneously."""
        cache = LRUCache(capacity=10)
        errors = []

        def writer(thread_id):
            try:
                for i in range(50):
                    cache.put(0, thread_id * 100 + i)
            except Exception as e:
                errors.append(e)

        def reader(thread_id):
            try:
                for i in range(50):
                    cache.get(0)
            except Exception as e:
                errors.append(e)

        threads = []
        for tid in range(5):
            threads.append(threading.Thread(target=writer, args=(tid,)))
            threads.append(threading.Thread(target=reader, args=(tid,)))

        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(errors), 0, f"Exceptions occurred: {errors}")
        # Key 0 should exist
        self.assertIn(0, cache)

    def test_concurrent_eviction(self):
        """Concurrent puts that trigger eviction should not lose data unexpectedly."""
        cache = LRUCache(capacity=10)
        num_threads = 20
        items_per_thread = 50

        def worker(thread_id):
            for i in range(items_per_thread):
                key = thread_id * items_per_thread + i
                cache.put(key, key)

        threads = [threading.Thread(target=worker, args=(tid,)) for tid in range(num_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Size should not exceed capacity
        self.assertLessEqual(cache.size(), cache.capacity)

    def test_stress(self):
        """Stress test with many threads doing mixed operations."""
        cache = LRUCache(capacity=50)
        num_threads = 20
        stop_flag = [False]

        def mixed_worker(thread_id):
            i = 0
            while not stop_flag[0] and i < 200:
                key = (thread_id * 7 + i * 3) % 100
                if i % 3 == 0:
                    cache.put(key, key * thread_id)
                else:
                    cache.get(key)
                i += 1

        threads = [threading.Thread(target=mixed_worker, args=(tid,)) for tid in range(num_threads)]
        for t in threads:
            t.start()
        time.sleep(0.1)
        stop_flag[0] = True
        for t in threads:
            t.join()

        self.assertLessEqual(cache.size(), cache.capacity)


# ---------------------------------------------------------------------------
# Usage Example
# ---------------------------------------------------------------------------

def usage_example():
    """Demonstrate LRU Cache usage."""
    print("=" * 50)
    print("LRU Cache Usage Example")
    print("=" * 50)

    # Create a cache with capacity 3
    cache = LRUCache(capacity=3)
    print(f"\n1. Created cache: {cache}")

    # Insert key-value pairs
    cache.put(1, "one")
    cache.put(2, "two")
    cache.put(3, "three")
    print(f"2. After put(1,'one'), put(2,'two'), put(3,'three'): {cache}")

    # Access key 1 (makes it most recently used)
    val = cache.get(1)
    print(f"3. get(1) = {val!r}  (accessed, now most recent)")

    # Insert key 4 — should evict key 2 (LRU)
    cache.put(4, "four")
    print(f"4. After put(4,'four'): {cache}")
    print(f"   get(2) = {cache.get(2)!r}  (evicted)")

    # Update existing key
    cache.put(1, "ONE")
    print(f"5. After put(1,'ONE'): {cache}")
    print(f"   get(1) = {cache.get(1)!r}")

    # Check size and membership
    print(f"6. size={cache.size()}, 1 in cache: {1 in cache}, 2 in cache: {2 in cache}")

    # Clear cache
    cache.clear()
    print(f"7. After clear(): {cache}")

    print("\n" + "=" * 50)
    print("Example complete.")
    print("=" * 50)


if __name__ == "__main__":
    # Run usage example
    usage_example()

    # Run unit tests
    print("\n" + "=" * 50)
    print("Running Unit Tests")
    print("=" * 50)
    unittest.main(argv=[""], exit=False, verbosity=2)
