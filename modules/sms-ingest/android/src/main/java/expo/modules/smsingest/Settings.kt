package expo.modules.smsingest

import org.json.JSONArray

/** Persisted sender substring patterns (R6). Unreadable data fails closed (no patterns = store nothing). */
class SenderPatterns(
  private val store: KeyValueStore,
  private val clock: () -> Long = System::currentTimeMillis,
) {
  fun get(): List<String> = synchronized(SmsQueue.LOCK) {
    val raw = store.read(KEY) ?: return@synchronized emptyList()
    try {
      val a = JSONArray(raw)
      (0 until a.length()).map { a.getString(it) }
    } catch (e: Exception) {
      store.quarantine(KEY, clock())
      emptyList()
    }
  }

  fun set(patterns: List<String>) = synchronized(SmsQueue.LOCK) {
    val clean = patterns.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
    store.write(KEY, JSONArray(clean).toString())
  }

  companion object {
    const val KEY = "sender_patterns.json"
  }
}

/** The engine the receiver and module use, plus what engineHealth/getTemplatesInfo report. */
data class LoadedEngine(
  val engine: TemplateEngine?,
  val usable: Boolean,
  val reason: String,
  /** "bundled" | "override" */
  val source: String,
  val version: Int?,
)

object EngineLoader {
  /**
   * Prefer the override (app files dir) when it builds and [selfTestOk]; otherwise the bundled
   * asset copy. An unusable result still carries the engine (if any) so the OTP drop can apply.
   */
  fun choose(overrideJson: String?, bundledJson: String?, selfTestOk: Boolean): LoadedEngine {
    val ov = overrideJson?.let { TemplateEngine.fromJson(it) }
    if (ov != null && selfTestOk) return LoadedEngine(ov, true, "ok", "override", ov.version)
    val b = bundledJson?.let { TemplateEngine.fromJson(it) }
      ?: return LoadedEngine(null, false, "no usable template set: bundled templates missing or invalid; SMS are stored unparsed", "bundled", null)
    if (!selfTestOk) {
      return LoadedEngine(b, false, "selfTest failed: regex named groups unsupported on this device; SMS are stored unparsed", "bundled", b.version)
    }
    val reason = if (overrideJson != null) "override templates invalid; using bundled" else "ok"
    return LoadedEngine(b, true, reason, "bundled", b.version)
  }
}
