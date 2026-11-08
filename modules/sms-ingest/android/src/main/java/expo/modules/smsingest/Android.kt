package expo.modules.smsingest

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.io.File

internal const val TAG = "SmsIngest"

/** Where the module keeps its state. The queue holds SMS text, so it lives in no_backup. */
internal object Storage {
  fun store(ctx: Context) = FileKeyValueStore(File(ctx.noBackupFilesDir, "sms-ingest"))

  fun queue(ctx: Context) = SmsQueue(store(ctx), System::currentTimeMillis, SmsQueue.MAX_ITEMS)

  fun patterns(ctx: Context) = SenderPatterns(store(ctx))

  @Volatile private var housekept = false

  /**
   * Once per process (module start or a receiver-only process start): deletes Task 2's spike
   * queue (any sender) and prunes quarantined `*.corrupt-*` files, which can hold raw SMS text
   * (see [Quarantine.prune]). Cheap: one prefs delete and one directory listing.
   */
  fun housekeeping(ctx: Context, now: Long = System.currentTimeMillis()) {
    if (housekept) return
    housekept = true
    try {
      ctx.deleteSharedPreferences("sms_ingest_spike")
    } catch (t: Throwable) {
      Log.w(TAG, "spike cleanup failed: ${t.javaClass.simpleName}")
    }
    try {
      // Same lock as every queue/settings read-modify-write, which is where quarantine happens.
      synchronized(SmsQueue.LOCK) { Quarantine.prune(store(ctx), now) }
    } catch (t: Throwable) {
      Log.w(TAG, "quarantine prune failed: ${t.javaClass.simpleName}")
    }
  }
}

/**
 * Template engine: the override in filesDir/templates/idfc.json if valid and not older than the
 * bundled asset, else the bundled asset (see [EngineLoader.choose]). Loaded on first use, never
 * at module creation, and cached ([LazyEngine]).
 */
internal object EngineProvider {
  private const val ASSET = "templates/idfc.json"

  private val lazy = LazyEngine()

  private fun overrideDir(ctx: Context) = File(ctx.filesDir, "templates")

  fun get(ctx: Context): LoadedEngine = lazy.get({ load(ctx) }) {
    if (!it.usable) Log.e(TAG, "template engine unusable: ${it.reason}")
  }

  /** Validates (TemplateEngine.fromJson) and writes atomically only when valid. */
  fun setOverride(ctx: Context, json: String): Boolean {
    if (TemplateEngine.fromJson(json) == null) return false
    lazy.update { FileKeyValueStore(overrideDir(ctx)).write("idfc.json", json) }
    return true
  }

  fun clearOverride(ctx: Context) {
    lazy.update { File(overrideDir(ctx), "idfc.json").delete() }
  }

  private fun load(ctx: Context): LoadedEngine {
    val selfTest = TemplateEngine.selfTest()
    val override = try {
      FileKeyValueStore(overrideDir(ctx)).read("idfc.json")
    } catch (t: Throwable) {
      null
    }
    val bundled = try {
      ctx.assets.open(ASSET).use { it.readBytes().toString(Charsets.UTF_8) }
    } catch (t: Throwable) {
      null
    }
    return EngineLoader.choose(override, bundled, selfTest)
  }
}

internal object Perms {
  fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

  fun notificationsAllowed(ctx: Context): Boolean =
    if (Build.VERSION.SDK_INT >= 33) granted(ctx, Manifest.permission.POST_NOTIFICATIONS)
    else NotificationManagerCompat.from(ctx).areNotificationsEnabled()

  fun wanted(): Array<String> {
    val base = arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
    return if (Build.VERSION.SDK_INT >= 33) base + Manifest.permission.POST_NOTIFICATIONS else base
  }
}

/** Receiver glue: filter, classify, store, then (only for parsed SMS) notify. */
internal object Ingestor {
  fun ingest(ctx: Context, parts: List<SmsPart>) {
    val filter = SenderFilter(Storage.patterns(ctx).get())
    if (!filter.hasPatterns) return
    val loaded = EngineProvider.get(ctx)
    val classifier = MessageClassifier(filter, loaded.engine, loaded.usable)
    val queue = Storage.queue(ctx)
    for (g in MultipartGrouper.group(parts)) {
      val d = classifier.classify(g.sender, g.body)
      if (d !is Decision.Store) continue
      val item = queue.append(g.sender, g.body, g.receivedAt, d.kind)
      val parse = d.parse ?: continue
      try {
        NotificationPoster.post(ctx, item, parse)
      } catch (t: Throwable) {
        Log.w(TAG, "notification failed: ${t.javaClass.simpleName}")
      }
    }
  }
}
