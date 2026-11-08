package expo.modules.smsingest

/**
 * Configured bank sender patterns (substrings such as `IDFCFB`), case-insensitive. With no
 * patterns nothing matches: the receiver stores nothing until the app has called setSenderPatterns.
 */
class SenderFilter(patterns: List<String>) {
  private val pats = patterns.map { it.trim() }.filter { it.isNotEmpty() }

  val hasPatterns: Boolean get() = pats.isNotEmpty()

  fun matches(sender: String): Boolean = pats.any { sender.contains(it, ignoreCase = true) }
}

/** One PDU of an SMS_RECEIVED intent. */
data class SmsPart(val address: String?, val body: String?, val timestampMillis: Long)

data class GroupedSms(val sender: String, val body: String, val receivedAt: Long)

/**
 * One intent can carry the parts of a multipart message and, rarely, parts from several senders.
 * Parts are grouped by originating address (first-seen order), bodies concatenated in PDU order;
 * sender and timestamp come from the first part of each group.
 */
object MultipartGrouper {
  fun group(parts: List<SmsPart>): List<GroupedSms> {
    val groups = LinkedHashMap<String, Pair<Long, StringBuilder>>()
    for (p in parts) {
      val addr = p.address ?: ""
      val g = groups.getOrPut(addr) { p.timestampMillis to StringBuilder() }
      g.second.append(p.body ?: "")
    }
    return groups.map { (addr, g) -> GroupedSms(addr, g.second.toString(), g.first) }
  }
}

sealed class Decision {
  /** Never stored. reason: "sender" | "otp" | "not_money". */
  data class Drop(val reason: String) : Decision()

  /** Stored with [kind]; [parse] is non-null only when a notification may be posted. */
  data class Store(val kind: String, val parse: NativeParse?) : Decision()
}

/**
 * Decides, before anything is stored, what happens to one SMS (R38):
 * sender not configured -> drop; parse succeeds -> store with the template kind and notify;
 * otherwise money-like (looksLikeMoney) -> store as "unrecognised", no notification; else drop
 * (OTP, ignore templates, marketing, other non-money).
 *
 * If the engine is unusable (no valid template set, or [TemplateEngine.selfTest] failed) the
 * message is stored as "unrecognised" without parsing, so nothing is silently lost; only the OTP
 * check (which uses no named groups) is still applied, if an engine object exists.
 */
class MessageClassifier(
  private val filter: SenderFilter,
  private val engine: TemplateEngine?,
  private val engineUsable: Boolean,
) {
  fun classify(sender: String, body: String): Decision {
    if (!filter.matches(sender)) return Decision.Drop("sender")
    if (engine == null) return Decision.Store(UNRECOGNISED, null)
    if (engine.isOtp(body)) return Decision.Drop("otp")
    if (!engineUsable) return Decision.Store(UNRECOGNISED, null)
    engine.parse(sender, body)?.let { return Decision.Store(it.kind, it) }
    return if (engine.looksLikeMoney(sender, body)) Decision.Store(UNRECOGNISED, null) else Decision.Drop("not_money")
  }

  /** Backfill uses the same drop rules; it only needs to know whether to return the message. */
  fun keep(sender: String, body: String): Boolean = classify(sender, body) is Decision.Store

  companion object {
    const val UNRECOGNISED = "unrecognised"
  }
}

/** Notification text, formed from the parse only (never the SMS body). */
object NotificationText {
  fun title(p: NativeParse): String {
    val amt = amount(p.amountMinor, p.currency)
    val tail = p.accountLast4?.takeIf { it.isNotEmpty() }?.let { " …$it" } ?: ""
    val phrase = when (p.kind) {
      "ca_credit" -> "credited to IDFC First"
      "ca_debit" -> "debited from IDFC First"
      "card_spend" -> "spent on IDFC card"
      "card_si_paid" -> "paid by standing instruction on IDFC card"
      "neft_confirm" -> "sent by NEFT from IDFC First"
      else -> if (p.direction == "in") "received in IDFC First" else "paid from IDFC First"
    }
    return "$amt $phrase$tail"
  }

  /** `₹12,34,567.89` for INR (Indian grouping), `USD 1,234.56` otherwise. Integer-only. */
  fun amount(minor: Long, currency: String): String {
    val neg = minor < 0
    val abs = if (neg) -minor else minor
    val whole = (abs / 100).toString()
    val frac = (abs % 100).toString().padStart(2, '0')
    val inr = currency.equals("INR", ignoreCase = true)
    val grouped = if (inr) groupIndian(whole) else groupThousands(whole)
    val sign = if (neg) "-" else ""
    return if (inr) "$sign₹$grouped.$frac" else "$sign${currency.uppercase()} $grouped.$frac"
  }

  /** Notification id derived from the stored queue id (unique per message, stable). */
  fun notificationId(queueId: String): Int = queueId.hashCode() and 0x7fffffff

  private fun groupThousands(d: String): String = d.reversed().chunked(3).joinToString(",").reversed()

  private fun groupIndian(d: String): String {
    if (d.length <= 3) return d
    val head = d.substring(0, d.length - 3)
    return head.reversed().chunked(2).joinToString(",").reversed() + "," + d.takeLast(3)
  }
}
