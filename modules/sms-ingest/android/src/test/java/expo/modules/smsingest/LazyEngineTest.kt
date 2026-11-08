package expo.modules.smsingest

import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Item 20B-6: the engine (asset/file reads, ~17 regex compiles, selfTest) loads on first use, once. */
class LazyEngineTest {
  private val loads = AtomicInteger()
  private fun loader(selfTestOk: Boolean = true): () -> LoadedEngine = {
    loads.incrementAndGet()
    EngineLoader.choose(null, RepoFiles.templateJson, selfTestOk)
  }

  @Test
  fun nothingIsLoadedUntilFirstUse() {
    val lazy = LazyEngine()
    assertFalse(lazy.isLoaded)
    assertEquals(0, loads.get())
    val l = lazy.get(loader())
    assertTrue(lazy.isLoaded)
    assertEquals(1, loads.get())
    assertTrue(l.usable)
    assertSame(l, lazy.get(loader()))
    assertEquals(1, loads.get())
  }

  @Test
  fun concurrentFirstCallsLoadExactlyOnce() {
    val lazy = LazyEngine()
    val start = CountDownLatch(1)
    val seen = java.util.Collections.synchronizedList(ArrayList<LoadedEngine>())
    val threads = (0 until 16).map {
      Thread {
        start.await()
        seen.add(lazy.get(loader()))
      }
    }
    threads.forEach { it.start() }
    start.countDown()
    threads.forEach { it.join() }
    assertEquals(1, loads.get())
    assertEquals(16, seen.size)
    assertTrue(seen.all { it === seen[0] })
  }

  @Test
  fun updateInvalidatesSoTheNextUseReloads() {
    val lazy = LazyEngine()
    val a = lazy.get(loader())
    assertTrue(lazy.update { true })
    assertFalse(lazy.isLoaded)
    val b = lazy.get(loader())
    assertEquals(2, loads.get())
    assertTrue(a !== b)
  }

  @Test
  fun aFailedLoadIsNotCachedAndIsRetried() {
    val lazy = LazyEngine()
    try {
      lazy.get({ throw IllegalStateException("disk") })
    } catch (e: IllegalStateException) {
      // expected
    }
    assertFalse(lazy.isLoaded)
    assertTrue(lazy.get(loader()).usable)
  }

  @Test
  fun healthOfAnUnusableEngineIsReportedOnFirstUse() {
    val lazy = LazyEngine()
    var logged: LoadedEngine? = null
    val l = lazy.get(loader(selfTestOk = false)) { logged = it }
    assertFalse(l.usable)
    assertTrue(l.reason, l.reason.contains("selfTest"))
    assertSame(l, logged)
    // onLoaded runs once per load, not per call.
    logged = null
    lazy.get(loader(selfTestOk = false)) { logged = it }
    assertEquals(null, logged)
  }
}
