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

/**
 * Lazily built, cached engine, shared by the module and the receiver. Nothing is loaded until
 * the first [get] (module start does no asset/file reads or regex compiles); concurrent first
 * calls load exactly once. [update] runs a change (e.g. writing the override) under the same lock
 * and drops the cache so the next [get] reloads. A load that throws is not cached.
 */
class LazyEngine {
  @Volatile private var cached: LoadedEngine? = null
  private val lock = Any()

  val isLoaded: Boolean get() = cached != null

  /** [onLoaded] runs once per actual load (e.g. to log an unusable engine), not per call. */
  fun get(load: () -> LoadedEngine, onLoaded: (LoadedEngine) -> Unit = {}): LoadedEngine =
    cached ?: synchronized(lock) {
      cached ?: load().also {
        cached = it
        onLoaded(it)
      }
    }

  fun <T> update(change: () -> T): T = synchronized(lock) {
    try {
      change()
    } finally {
      cached = null
    }
  }
}

object EngineLoader {
  /**
   * The override (app files dir) is used only when it builds and its version is >= the bundled
   * set's (the TS side applies the same rule to `templates_json`), so a stale override cannot
   * shadow newer bundled templates after an app update; a missing version counts as 0. If the
   * bundled asset is missing or invalid, a valid override is used whatever its version. With a
   * failed [selfTestOk] the result is unusable but still carries an engine (bundled first) so the
   * OTP drop can apply.
   */
  fun choose(overrideJson: String?, bundledJson: String?, selfTestOk: Boolean): LoadedEngine {
    val ov = overrideJson?.let { TemplateEngine.fromJson(it) }
    val b = bundledJson?.let { TemplateEngine.fromJson(it) }
    if (!selfTestOk) {
      val e = b ?: ov
        ?: return LoadedEngine(null, false, "no usable template set and selfTest failed; SMS are stored unparsed", "bundled", null)
      return LoadedEngine(
        e, false, "selfTest failed: regex named groups unsupported on this device; SMS are stored unparsed",
        if (e === b) "bundled" else "override", e.version,
      )
    }
    if (ov != null && (b == null || ov.version >= b.version)) {
      return LoadedEngine(ov, true, if (b == null) "bundled templates invalid; using override" else "ok", "override", ov.version)
    }
    if (b == null) {
      return LoadedEngine(null, false, "no usable template set: bundled templates missing or invalid; SMS are stored unparsed", "bundled", null)
    }
    val reason = when {
      overrideJson == null -> "ok"
      ov == null -> "override templates invalid; using bundled"
      else -> "override version ${ov.version} is older than bundled ${b.version}; using bundled"
    }
    return LoadedEngine(b, true, reason, "bundled", b.version)
  }
}
