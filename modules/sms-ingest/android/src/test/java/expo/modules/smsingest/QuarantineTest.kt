package expo.modules.smsingest

import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Item 20B-4: quarantined `<key>.corrupt-<ms>` files hold raw SMS text; keep at most the latest per key, for 7 days. */
class QuarantineTest {
  private val day = 86_400_000L
  private val t0 = 1_800_000_000_000L

  private fun corrupt(store: KeyValueStore) = store.keys().filter { it.contains(".corrupt-") }.sorted()

  private fun stores(): List<Pair<KeyValueStore, () -> Unit>> {
    val dir = Files.createTempDirectory("kvq").toFile()
    return listOf(MemoryKeyValueStore() to {}, FileKeyValueStore(dir) to { dir.deleteRecursively(); Unit })
  }

  @Test
  fun quarantineKeepsOnlyTheMostRecentPerKey() {
    for ((s, done) in stores()) {
      try {
        for (i in 1..3) {
          s.write("queue.json", "bad $i")
          assertEquals("queue.json.corrupt-${t0 + i}", s.quarantine("queue.json", t0 + i))
        }
        assertEquals(listOf("queue.json.corrupt-${t0 + 3}"), corrupt(s))
        assertEquals("bad 3", s.read("queue.json.corrupt-${t0 + 3}"))
        assertNull(s.read("queue.json"))
        // Another key keeps its own latest; plain keys are never touched.
        s.write("sender_patterns.json", "{oops")
        s.write("dropped", "7")
        s.quarantine("sender_patterns.json", t0 + 10)
        assertEquals(listOf("queue.json.corrupt-${t0 + 3}", "sender_patterns.json.corrupt-${t0 + 10}"), corrupt(s))
        assertEquals("7", s.read("dropped"))
        assertNull(s.quarantine("absent", t0 + 11))
      } finally {
        done()
      }
    }
  }

  @Test
  fun pruneAtStartDeletesAnythingOlderThanSevenDays() {
    for ((s, done) in stores()) {
      try {
        s.write("queue.json", "old")
        s.quarantine("queue.json", t0)
        s.write("sender_patterns.json", "newer")
        s.quarantine("sender_patterns.json", t0 + 5 * day)
        s.write("queue.json", "live")
        assertEquals(0, Quarantine.prune(s, t0 + 7 * day))
        assertEquals(2, corrupt(s).size)
        assertEquals(1, Quarantine.prune(s, t0 + 7 * day + 1))
        assertEquals(listOf("sender_patterns.json.corrupt-${t0 + 5 * day}"), corrupt(s))
        assertEquals(1, Quarantine.prune(s, t0 + 13 * day))
        assertEquals(emptyList<String>(), corrupt(s))
        assertEquals("live", s.read("queue.json"))
      } finally {
        done()
      }
    }
  }

  @Test
  fun pruneAlsoReducesLeftoversFromBeforeTheRuleToOnePerKey() {
    val s = MemoryKeyValueStore()
    for (i in 1..4) s.data["queue.json.corrupt-${t0 + i}"] = "body $i"
    s.data["queue.json.corrupt-notanumber"] = "x"
    s.data["queue.json"] = "{}"
    assertEquals(3, Quarantine.prune(s, t0 + day))
    assertEquals(listOf("queue.json.corrupt-${t0 + 4}", "queue.json.corrupt-notanumber"), corrupt(s))
  }

  @Test
  fun aStampInTheFutureCountsAsFreshAndIsKeptIfNewest() {
    val s = MemoryKeyValueStore()
    s.data["queue.json.corrupt-${t0 + day}"] = "a"
    s.data["queue.json.corrupt-$t0"] = "b"
    assertEquals(1, Quarantine.prune(s, t0))
    assertEquals(listOf("queue.json.corrupt-${t0 + day}"), corrupt(s))
  }

  @Test
  fun aQueueCorruptedTwiceLeavesOneQuarantinedFileOnDisk() {
    val dir = Files.createTempDirectory("kvq").toFile()
    try {
      val t = AtomicLong(t0)
      val clock = { t.incrementAndGet() }
      File(dir, SmsQueue.KEY).writeText("garbage 1")
      SmsQueue(FileKeyValueStore(dir), clock, 500).peek()
      File(dir, SmsQueue.KEY).writeText("garbage 2")
      SmsQueue(FileKeyValueStore(dir), clock, 500).peek()
      val moved = dir.listFiles()!!.filter { it.name.startsWith("${SmsQueue.KEY}.corrupt-") }
      assertEquals(1, moved.size)
      assertEquals("garbage 2", moved[0].readText())
      assertTrue(dir.listFiles()!!.none { it.name.endsWith(".tmp") })
    } finally {
      dir.deleteRecursively()
    }
  }
}
