package expo.modules.smsingest

import java.util.regex.Pattern
import org.json.JSONObject

/** What a notification needs from a parsed SMS. Money is integer minor units (paise/cents). */
data class NativeParse(
  val kind: String,
  val direction: String,
  val amountMinor: Long,
  val currency: String,
  val accountLast4: String?,
)

/**
 * Kotlin port of src/core/parser/engine.ts, driven by the same templates/idfc.json (copied into
 * assets at build time; the JSON is the single source). No JavaScript, so it works with the app
 * process dead. Keep the decision order identical to the TS engine:
 *
 *  1. otpPattern on the whole body -> null
 *  2. first bank whose senderPattern is a substring of the sender (none -> null)
 *  3. first template whose regex matches wins; kind "ignore" -> null
 *  4. nothing matched -> null; [looksLikeMoney] gives the TS unknown_template/not_money split
 *
 * Port notes:
 *  - All patterns compile with CASE_INSENSITIVE and no inline flags (R1). Named groups are read
 *    with Matcher.group(String), which needs Android API 26+ (minSdk is 26; see [selfTest]).
 *  - Java's \s is ASCII-only, JS's is Unicode-aware, so the body is normalised first: every
 *    Unicode space separator (NBSP U+00A0, U+2009, U+202F, ...), U+FEFF, U+2028 and U+2029
 *    become a plain space.
 *  - Optional groups that did not participate are null.
 *  - Money is parsed with integer arithmetic exactly like parseMinor in src/core/money.ts.
 *  - [parse] is total: any fault returns null.
 */
class TemplateEngine private constructor(
  private val otp: Pattern,
  private val moneyVerb: Pattern,
  private val amountRx: Pattern,
  private val banks: List<Bank>,
  /** The template set's top-level "version", or null when absent. */
  val version: Int?,
) {
  private class Template(
    val kind: String,
    val direction: String,
    val regex: Pattern,
  )

  private class Bank(val senderPattern: String, val templates: List<Template>)

  fun parse(sender: String, body: String): NativeParse? {
    return try {
      parseUnsafe(sender, normalise(body))
    } catch (e: Throwable) {
      null
    }
  }

  /** True when the body is an OTP (the template set's otpPattern, after space normalisation). */
  fun isOtp(body: String): Boolean = try {
    otp.matcher(normalise(body)).find()
  } catch (e: Throwable) {
    false
  }

  /**
   * True iff the body is not an OTP, is not matched (first match wins) by an ignore template of
   * the sender's bank, and matches both moneyVerbPattern and amountPattern: the rule the TS engine
   * uses to choose unknown_template over not_money. Every SMS that parses is also money-like.
   * Used to keep an unparsed money SMS (stored as "unrecognised") instead of dropping it.
   */
  fun looksLikeMoney(sender: String, body: String): Boolean = try {
    val b = normalise(body)
    when {
      otp.matcher(b).find() -> false
      firstMatchIsIgnore(sender, b) -> false
      else -> moneyVerb.matcher(b).find() && amountRx.matcher(b).find()
    }
  } catch (e: Throwable) {
    false
  }

  private fun firstMatchIsIgnore(sender: String, body: String): Boolean {
    val bank = banks.firstOrNull { sender.contains(it.senderPattern) } ?: return false
    val tpl = bank.templates.firstOrNull { it.regex.matcher(body).find() } ?: return false
    return tpl.kind == "ignore"
  }

  private fun parseUnsafe(sender: String, body: String): NativeParse? {
    if (otp.matcher(body).find()) return null
    val bank = banks.firstOrNull { sender.contains(it.senderPattern) } ?: return null
    for (tpl in bank.templates) {
      val m = tpl.regex.matcher(body)
      if (!m.find()) continue
      if (tpl.kind == "ignore") return null
      fun g(name: String): String? = try { m.group(name) } catch (e: IllegalArgumentException) { null }

      // Validate the same date/time faults the TS engine rejects (the result is unused natively).
      val day = g("day")
      val month = g("month")
      val year = g("year")
      if (!day.isNullOrEmpty() && !month.isNullOrEmpty() && !year.isNullOrEmpty()) {
        val mo = monthNumber(month)
        val dd = day.toInt()
        if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null
      }
      g("time")?.let { if (it.isNotEmpty()) checkTime(it) }
      g("balance")?.let { if (it.isNotEmpty()) parseMinor(it) }

      return NativeParse(
        kind = tpl.kind,
        direction = tpl.direction,
        amountMinor = parseMinor(g("amount") ?: return null),
        currency = normCurrency(g("currency")),
        accountLast4 = g("last4"),
      )
    }
    return null
  }

  companion object {
    private const val FLAGS = Pattern.CASE_INSENSITIVE
    private val UNICODE_SPACES = Regex("[\\p{Zs}\\uFEFF\\u2028\\u2029]")
    private val MONEY = Regex("(\\d[\\d,]*)(?:\\.(\\d*))?")
    private val TIME = Regex("^(\\d{1,2}):(\\d{2})\\s*([AP]M)?$", RegexOption.IGNORE_CASE)
    private val MONTHS = listOf("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")

    /** Replace Unicode space characters with a plain space so Java's ASCII-only \s behaves like JS's. */
    internal fun normalise(body: String): String = UNICODE_SPACES.replace(body, " ")

    /**
     * Build an engine from a templates JSON string. Returns null when the set is unusable:
     * not JSON, otpPattern / moneyVerbPattern / amountPattern / banks missing or empty, or any
     * regex fails to compile. (An empty otpPattern would match every body and classify every SMS
     * as an OTP, so the caller must fall back to the bundled set on null.)
     */
    fun fromJson(json: String): TemplateEngine? {
      return try {
        val root = JSONObject(json)
        val otp = compileRequired(root, "otpPattern")
        val moneyVerb = compileRequired(root, "moneyVerbPattern")
        val amountRx = compileRequired(root, "amountPattern")
        val banksJson = root.optJSONArray("banks") ?: return null
        if (banksJson.length() == 0) return null
        val banks = ArrayList<Bank>()
        for (i in 0 until banksJson.length()) {
          val b = banksJson.getJSONObject(i)
          val sp = b.getString("senderPattern")
          if (sp.isEmpty()) return null
          val tj = b.getJSONArray("templates")
          val tpls = ArrayList<Template>()
          for (j in 0 until tj.length()) {
            val t = tj.getJSONObject(j)
            val kind = t.getString("kind")
            if (kind.isEmpty()) return null
            val rx = t.getString("regex")
            if (rx.isEmpty()) return null
            tpls.add(Template(kind, if (t.has("direction")) t.getString("direction") else "out", Pattern.compile(rx, FLAGS)))
          }
          banks.add(Bank(sp, tpls))
        }
        val version = if (root.has("version") && !root.isNull("version")) root.getInt("version") else null
        TemplateEngine(otp, moneyVerb, amountRx, banks, version)
      } catch (e: Throwable) {
        null
      }
    }

    /**
     * True when named groups can be compiled and read via Matcher.group(String) (API 26+).
     * Task 9 should call this at receiver start and fail loudly rather than drop SMS silently.
     */
    fun selfTest(): Boolean {
      return try {
        val m = Pattern.compile("(?<probe>\\d+)", FLAGS).matcher("a12")
        m.find() && m.group("probe") == "12"
      } catch (e: Throwable) {
        false
      }
    }

    private fun compileRequired(root: JSONObject, key: String): Pattern {
      val s = root.getString(key)
      require(s.isNotBlank()) { "$key is empty" }
      val p = Pattern.compile(s, FLAGS)
      require(!p.matcher("").find()) { "$key matches the empty string" }
      return p
    }

    private fun monthNumber(m: String): Int {
      if (m.all { it in '0'..'9' }) return m.toInt()
      val i = MONTHS.indexOf(m.take(3).lowercase())
      require(i >= 0) { "bad month $m" }
      return i + 1
    }

    private fun checkTime(t: String) {
      val m = requireNotNull(TIME.find(t.trim())) { "bad time $t" }
      require(m.groupValues[1].toInt() <= 23 && m.groupValues[2].toInt() <= 59) { "bad time $t" }
    }

    /** Integer-only port of parseMinor: no Double anywhere. */
    internal fun parseMinor(text: String): Long {
      val m = requireNotNull(MONEY.find(text)) { "no amount in \"$text\"" }
      val whole = m.groupValues[1].replace(",", "").toLong()
      val frac = (m.groupValues[2] + "00").take(2).toLong()
      return Math.addExact(Math.multiplyExact(whole, 100L), frac)
    }

    private fun normCurrency(c: String?): String {
      if (c.isNullOrEmpty()) return "INR"
      return if (c.startsWith("rs", ignoreCase = true)) "INR" else c.uppercase()
    }
  }
}
