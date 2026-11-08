package expo.modules.smsingest

import org.json.JSONArray
import org.json.JSONObject

data class QueuedSms(
  val id: String,
  val sender: String,
  val body: String,
  val receivedAt: Long,
  val kind: String,
  /**
   * The queue's persisted, monotonic sequence number for this item (1, 2, 3, ...; it survives
   * restarts and acks), used for the notification id. Not sent over the JS bridge.
   */
  val seq: Long,
)

/**
 * Durable native queue between the receiver (app process possibly started just for the SMS) and
 * the JS pipeline. JS calls [peek] (never removes) and, once it has persisted the items, [ack]
 * (removes exactly those ids), so a crash in between cannot lose a message; the TS pipeline is
 * idempotent on rawHash, so a re-delivered item is harmless.
 *
 * Bounded to [maxItems]: the oldest are dropped and counted in a persisted counter. Every
 * read-modify-write runs under one process-wide lock (the receiver and the module are separate
 * instances in the same process) and each write is atomic (see [KeyValueStore.write]). A queue
 * that cannot be parsed is quarantined (moved aside with a timestamp) and the queue restarts empty.
 */
class SmsQueue(
  private val store: KeyValueStore,
  private val clock: () -> Long = System::currentTimeMillis,
  private val maxItems: Int = 500,
) {
  private class Doc(var seq: Long, val items: MutableList<QueuedSms>)

  fun append(sender: String, body: String, receivedAt: Long, kind: String): QueuedSms = synchronized(LOCK) {
    val doc = load()
    doc.seq += 1
    val item = QueuedSms("${clock()}-${doc.seq}", sender, body, receivedAt, kind, doc.seq)
    doc.items.add(item)
    val over = doc.items.size - maxItems
    if (over > 0) {
      repeat(over) { doc.items.removeAt(0) }
      // Count first: a crash between the two writes over-counts rather than hides a loss.
      store.write(DROPPED_KEY, (readDropped() + over).toString())
    }
    save(doc)
    item
  }

  fun peek(): List<QueuedSms> = synchronized(LOCK) { load().items.toList() }

  fun ack(ids: Collection<String>) = synchronized(LOCK) {
    if (ids.isEmpty()) return@synchronized
    val doc = load()
    val gone = ids.toSet()
    if (doc.items.removeAll { it.id in gone }) save(doc)
  }

  fun droppedCount(): Long = synchronized(LOCK) { readDropped() }

  private fun readDropped(): Long {
    val s = store.read(DROPPED_KEY) ?: return 0L
    return s.trim().toLongOrNull() ?: run {
      store.quarantine(DROPPED_KEY, clock())
      0L
    }
  }

  private fun load(): Doc {
    val raw = store.read(KEY) ?: return Doc(0L, ArrayList())
    return try {
      val o = JSONObject(raw)
      val arr = o.getJSONArray("items")
      val items = ArrayList<QueuedSms>(arr.length())
      for (i in 0 until arr.length()) {
        val it = arr.getJSONObject(i)
        val id = it.getString("id")
        items.add(
          QueuedSms(
            id,
            it.getString("sender"),
            it.getString("body"),
            it.getLong("receivedAt"),
            it.getString("kind"),
            // Items written before seq was stored: the id is "<clock>-<seq>".
            if (it.has("seq")) it.getLong("seq") else id.substringAfterLast('-').toLongOrNull() ?: 0L,
          ),
        )
      }
      Doc(o.getLong("seq"), items)
    } catch (e: Exception) {
      // Keep the bad file for inspection; never silently empty it. Ids stay unique because they
      // carry the clock as well as the restarted sequence.
      store.quarantine(KEY, clock())
      Doc(0L, ArrayList())
    }
  }

  private fun save(doc: Doc) {
    val arr = JSONArray()
    for (it in doc.items) {
      arr.put(
        JSONObject()
          .put("id", it.id)
          .put("sender", it.sender)
          .put("body", it.body)
          .put("receivedAt", it.receivedAt)
          .put("kind", it.kind)
          .put("seq", it.seq),
      )
    }
    store.write(KEY, JSONObject().put("v", 1).put("seq", doc.seq).put("items", arr).toString())
  }

  companion object {
    const val KEY = "queue.json"
    const val DROPPED_KEY = "dropped"
    const val MAX_ITEMS = 500

    /** Process-wide: every SmsQueue instance serialises on this. */
    val LOCK = Any()
  }
}
