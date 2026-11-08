package expo.modules.smsingest

import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsQueueTest {
  private val t = AtomicLong(1_000L)
  private val clock = { t.incrementAndGet() }

  @Test
  fun appendThenPeekReturnsItemsInOrderWithoutRemoving() {
    val q = SmsQueue(MemoryKeyValueStore(), clock, 500)
    val a = q.append("JM-IDFCFB-S", "one", 10L, "ca_credit")
    val b = q.append("JM-IDFCFB-S", "two", 20L, "unrecognised")
    val p1 = q.peek()
    assertEquals(listOf(a, b), p1)
    assertEquals(p1, q.peek())
    assertEquals("one", p1[0].body)
    assertEquals(10L, p1[0].receivedAt)
    assertEquals("ca_credit", p1[0].kind)
    assertTrue(a.id != b.id)
  }

  @Test
  fun ackRemovesExactlyTheGivenIds() {
    val q = SmsQueue(MemoryKeyValueStore(), clock, 500)
    val a = q.append("S", "a", 1L, "k")
    val b = q.append("S", "b", 2L, "k")
    val c = q.append("S", "c", 3L, "k")
    q.ack(listOf(a.id, c.id, "no-such-id"))
    assertEquals(listOf(b), q.peek())
    q.ack(emptyList())
    assertEquals(listOf(b), q.peek())
    q.ack(listOf(b.id))
    assertEquals(emptyList<QueuedSms>(), q.peek())
  }

  @Test
  fun boundDropsOldestAndCountsDropped() {
    val q = SmsQueue(MemoryKeyValueStore(), clock, 3)
    assertEquals(0L, q.droppedCount())
    val items = (1..5).map { q.append("S", "m$it", it.toLong(), "k") }
    assertEquals(items.takeLast(3), q.peek())
    assertEquals(2L, q.droppedCount())
  }

  @Test
  fun persistsAcrossReinstantiation() {
    val store = MemoryKeyValueStore()
    val q1 = SmsQueue(store, clock, 2)
    q1.append("S", "a", 1L, "k")
    q1.append("S", "b", 2L, "k")
    q1.append("S", "c", 3L, "k")
    val q2 = SmsQueue(store, clock, 2)
    assertEquals(q1.peek(), q2.peek())
    assertEquals(1L, q2.droppedCount())
    val d = q2.append("S", "d", 4L, "k")
    assertTrue(q1.peek().contains(d))
  }

  @Test
  fun persistsAcrossReinstantiationOnFileStore() {
    val dir = Files.createTempDirectory("smsq").toFile()
    try {
      val q1 = SmsQueue(FileKeyValueStore(dir), clock, 500)
      val a = q1.append("JM-IDFCFB-S", "body ₹ ü", 5L, "card_spend")
      val q2 = SmsQueue(FileKeyValueStore(dir), clock, 500)
      assertEquals(listOf(a), q2.peek())
      assertTrue(dir.listFiles()!!.none { it.name.endsWith(".tmp") })
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun idsStayUniqueAfterAckAndReinstantiation() {
    val store = MemoryKeyValueStore()
    val fixed = { 42L }
    val q = SmsQueue(store, fixed, 500)
    val a = q.append("S", "a", 1L, "k")
    q.ack(listOf(a.id))
    val b = SmsQueue(store, fixed, 500).append("S", "b", 1L, "k")
    assertTrue(a.id != b.id)
  }

  @Test
  fun corruptQueueIsQuarantinedAndQueueContinues() {
    val store = MemoryKeyValueStore()
    store.data[SmsQueue.KEY] = "{not json"
    val q = SmsQueue(store, clock, 500)
    assertEquals(emptyList<QueuedSms>(), q.peek())
    val quarantined = store.data.keys.filter { it.startsWith("${SmsQueue.KEY}.corrupt-") }
    assertEquals(1, quarantined.size)
    assertEquals("{not json", store.data[quarantined[0]])
    val a = q.append("S", "a", 1L, "k")
    assertEquals(listOf(a), q.peek())
  }

  @Test
  fun structurallyInvalidItemQuarantinesToo() {
    val store = MemoryKeyValueStore()
    store.data[SmsQueue.KEY] = """{"v":1,"seq":3,"items":[{"id":"x","sender":"S"}]}"""
    val q = SmsQueue(store, clock, 500)
    assertEquals(emptyList<QueuedSms>(), q.peek())
    assertEquals(1, store.data.keys.count { it.startsWith("${SmsQueue.KEY}.corrupt-") })
  }

  @Test
  fun corruptQueueFileIsRenamedOnDisk() {
    val dir = Files.createTempDirectory("smsq").toFile()
    try {
      File(dir, SmsQueue.KEY).writeText("garbage")
      val q = SmsQueue(FileKeyValueStore(dir), clock, 500)
      assertEquals(emptyList<QueuedSms>(), q.peek())
      val moved = dir.listFiles()!!.filter { it.name.startsWith("${SmsQueue.KEY}.corrupt-") }
      assertEquals(1, moved.size)
      assertEquals("garbage", moved[0].readText())
      assertNotNull(q.append("S", "a", 1L, "k"))
      assertEquals(1, q.peek().size)
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun notificationIdsAreUniqueAcrossTenThousandSequentialItems() {
    val store = MemoryKeyValueStore()
    val fixed = { 1_700_000_000_000L }
    val ids = HashSet<Int>()
    var q = SmsQueue(store, fixed, 500)
    for (i in 1..10_000) {
      val item = q.append("S", "m$i", i.toLong(), "k")
      assertEquals(i.toLong(), item.seq)
      assertTrue(ids.add(NotificationText.notificationId(item.seq)))
      // Ack as JS does, and restart the "process" now and then: seq is persisted, so it continues.
      if (i % 100 == 0) q.ack(q.peek().map { it.id })
      if (i % 1000 == 0) q = SmsQueue(store, fixed, 500)
    }
    assertEquals(10_000, ids.size)
    assertTrue(ids.all { it > 0 })
  }

  @Test
  fun seqSurvivesRestartOnTheFileStoreAfterEverythingIsAcked() {
    val dir = Files.createTempDirectory("smsq").toFile()
    try {
      val a = SmsQueue(FileKeyValueStore(dir), clock, 500).append("S", "a", 1L, "k")
      SmsQueue(FileKeyValueStore(dir), clock, 500).ack(listOf(a.id))
      val b = SmsQueue(FileKeyValueStore(dir), clock, 500).append("S", "b", 2L, "k")
      assertEquals(a.seq + 1, b.seq)
      assertNotEquals(NotificationText.notificationId(a.seq), NotificationText.notificationId(b.seq))
      assertEquals(listOf(b), SmsQueue(FileKeyValueStore(dir), clock, 500).peek())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun legacyItemsWithoutSeqTakeItFromTheirId() {
    val store = MemoryKeyValueStore()
    store.data[SmsQueue.KEY] =
      """{"v":1,"seq":5,"items":[{"id":"1700000000000-5","sender":"S","body":"b","receivedAt":1,"kind":"k"}]}"""
    val q = SmsQueue(store, clock, 500)
    assertEquals(5L, q.peek().single().seq)
    assertEquals(6L, q.append("S", "c", 2L, "k").seq)
  }

  @Test
  fun concurrentAppendsLoseNothing() {
    val store = MemoryKeyValueStore()
    val threads = 8
    val per = 50
    val start = CountDownLatch(1)
    val workers = (0 until threads).map { n ->
      Thread {
        start.await()
        // A separate instance per thread, like the receiver and the module in one process.
        val q = SmsQueue(store, clock, 500)
        repeat(per) { i -> q.append("S$n", "t$n-$i", i.toLong(), "k") }
      }
    }
    workers.forEach { it.start() }
    start.countDown()
    workers.forEach { it.join() }
    val all = SmsQueue(store, clock, 500).peek()
    assertEquals(threads * per, all.size)
    assertEquals(threads * per, all.map { it.id }.toSet().size)
    assertEquals(threads * per, all.map { NotificationText.notificationId(it.seq) }.toSet().size)
    assertEquals(threads * per, all.map { it.body }.toSet().size)
    assertEquals(0L, SmsQueue(store, clock, 500).droppedCount())
  }
}
