package expo.modules.smsingest

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SenderPatternsTest {
  @Test
  fun emptyUntilSetThenPersisted() {
    val store = MemoryKeyValueStore()
    assertEquals(emptyList<String>(), SenderPatterns(store).get())
    SenderPatterns(store).set(listOf(" IDFCFB ", "", "IDFCFB", "TESTPAT"))
    assertEquals(listOf("IDFCFB", "TESTPAT"), SenderPatterns(store).get())
    SenderPatterns(store).set(emptyList())
    assertEquals(emptyList<String>(), SenderPatterns(store).get())
  }

  @Test
  fun corruptPatternsFailClosedAndAreQuarantined() {
    val store = MemoryKeyValueStore()
    store.data[SenderPatterns.KEY] = "{oops"
    assertEquals(emptyList<String>(), SenderPatterns(store).get())
    assertEquals(1, store.data.keys.count { it.startsWith("${SenderPatterns.KEY}.corrupt-") })
  }
}

class EngineLoaderTest {
  private val bundled = RepoFiles.templateJson
  private fun withVersion(v: Int) = JSONObject(bundled).put("version", v).toString()

  @Test
  fun bundledWhenNoOverride() {
    val l = EngineLoader.choose(null, bundled, selfTestOk = true)
    assertTrue(l.usable)
    assertEquals("bundled", l.source)
    assertEquals(1, l.version)
    assertNotNull(l.engine)
  }

  @Test
  fun validOverrideWins() {
    val l = EngineLoader.choose(withVersion(7), bundled, selfTestOk = true)
    assertTrue(l.usable)
    assertEquals("override", l.source)
    assertEquals(7, l.version)
  }

  @Test
  fun invalidOverrideFallsBackToBundled() {
    val l = EngineLoader.choose(JSONObject(bundled).put("otpPattern", "").toString(), bundled, selfTestOk = true)
    assertTrue(l.usable)
    assertEquals("bundled", l.source)
    assertTrue(l.reason, l.reason.contains("override"))
  }

  @Test
  fun selfTestFailureIsUnusable() {
    val l = EngineLoader.choose(withVersion(7), bundled, selfTestOk = false)
    assertFalse(l.usable)
    assertEquals("bundled", l.source)
    assertTrue(l.reason, l.reason.contains("selfTest"))
  }

  @Test
  fun noUsableTemplatesAtAll() {
    val l = EngineLoader.choose("junk", null, selfTestOk = true)
    assertFalse(l.usable)
    assertNull(l.engine)
    assertNull(l.version)
  }
}
