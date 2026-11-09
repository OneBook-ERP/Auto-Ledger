package expo.modules.smsingest

/**
* The inbox query for a backfill. `days > 0` bounds the date from below (capped at ten years);
* `days == 0` means all time: no lower date bound at all. A negative window reads nothing.
*/
object BackfillQuery {
  const val MAX_DAYS = 3650
  const val CAP = 5000
  private const val DAY_MS = 86_400_000L

  /** What to ask the content resolver for; [selection] and [args] are null when there is no date bound. */
  data class Bounds(val selection: String?, val args: Array<String>?)

  /** False for a negative window (nothing to read). 0 is valid and means all time. */
  fun reads(days: Int): Boolean = days >= 0

  /** The oldest allowed `date` in millis, or null for all time (days == 0). */
  fun since(days: Int, now: Long): Long? =
    if (days <= 0) null else now - days.coerceAtMost(MAX_DAYS).toLong() * DAY_MS

  fun bounds(days: Int, now: Long, dateColumn: String): Bounds {
    val s = since(days, now) ?: return Bounds(null, null)
    return Bounds("$dateColumn >= ?", arrayOf(s.toString()))
  }
}
