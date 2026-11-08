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
    assertEquals(JSONObject(bundled).getInt("version"), l.version)
    assertNotNull(l.engine)
  }

  private val bundledVersion = JSONObject(bundled).getInt("version")

  @Test
  fun validOverrideWins() {
    val l = EngineLoader.choose(withVersion(7), bundled, selfTestOk = true)
    assertTrue(l.usable)
    assertEquals("override", l.source)
    assertEquals(7, l.version)
  }

  @Test
  fun newerOverrideWins() {
    val l = EngineLoader.choose(withVersion(bundledVersion + 1), bundled, selfTestOk = true)
    assertEquals("override", l.source)
    assertEquals(bundledVersion + 1, l.version)
    assertEquals("ok", l.reason)
  }

  @Test
  fun equalVersionOverrideWins() {
    // Same rule as the TS side (templates_json is used when version >= bundled): the debug
    // screen's "Use test templates" stores the bundled set plus a test bank at the same version.
    val ov = JSONObject(bundled)
    ov.getJSONArray("banks").getJSONObject(0).put("senderPattern", "TESTPAT")
    val l = EngineLoader.choose(ov.toString(), bundled, selfTestOk = true)
    assertTrue(l.usable)
    assertEquals("override", l.source)
    assertEquals(bundledVersion, l.version)
    assertNotNull(l.engine!!.parse("xxTESTPATxx", RepoFiles.fixtures.getJSONObject(0).getString("body")))
  }

  @Test
  fun olderOverrideIsIgnored() {
    val ov = JSONObject(bundled).put("version", bundledVersion - 1)
    ov.getJSONArray("banks").getJSONObject(0).put("senderPattern", "TESTPAT")
    val l = EngineLoader.choose(ov.toString(), bundled, selfTestOk = true)
    assertTrue(l.usable)
    assertEquals("bundled", l.source)
    assertEquals(bundledVersion, l.version)
    assertTrue(l.reason, l.reason.contains("older"))
    // The stale override's sender pattern is not active.
    assertNull(l.engine!!.parse("xxTESTPATxx", RepoFiles.fixtures.getJSONObject(0).getString("body")))
  }

  @Test
  fun overrideWithoutVersionCountsAsZeroAndLosesToBundled() {
    val ov = JSONObject(bundled).also { it.remove("version") }.toString()
    val l = EngineLoader.choose(ov, bundled, selfTestOk = true)
    assertEquals("bundled", l.source)
    assertEquals(bundledVersion, l.version)
  }

  @Test
  fun validOverrideIsUsedWhenTheBundledSetIsBroken() {
    val l = EngineLoader.choose(withVersion(1), "junk", selfTestOk = true)
    assertTrue(l.usable)
    assertEquals("override", l.source)
    assertEquals(1, l.version)
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

  @Test
  fun setTemplatesRejectsAnOverrideOlderThanBundled() {
    val ver = JSONObject(bundled).getInt("version")
    assertTrue(EngineLoader.acceptsOverride(withVersion(ver), bundled))
    assertTrue(EngineLoader.acceptsOverride(withVersion(ver + 1), bundled))
    assertFalse(EngineLoader.acceptsOverride(withVersion(ver - 1), bundled))
    // A missing version counts as 0.
    assertFalse(EngineLoader.acceptsOverride(JSONObject(bundled).also { it.remove("version") }.toString(), bundled))
    // Invalid templates are rejected; with no usable bundled set any valid override is accepted.
    assertFalse(EngineLoader.acceptsOverride("{nope", bundled))
    assertTrue(EngineLoader.acceptsOverride(withVersion(0), null))
  }
}
