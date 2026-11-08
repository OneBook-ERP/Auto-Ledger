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

  /** Task 2's spike queue (any sender). Deleted on first load of the production module/receiver. */
  @Volatile private var spikeCleaned = false

  fun deleteSpikeLeftovers(ctx: Context) {
    if (spikeCleaned) return
    spikeCleaned = true
    try {
      ctx.deleteSharedPreferences("sms_ingest_spike")
    } catch (t: Throwable) {
      Log.w(TAG, "spike cleanup failed: ${t.javaClass.simpleName}")
    }
  }
}

/** Cached template engine: the override in filesDir/templates/idfc.json if valid, else the bundled asset. */
internal object EngineProvider {
  private const val ASSET = "templates/idfc.json"

  @Volatile private var cached: LoadedEngine? = null

  private fun overrideDir(ctx: Context) = File(ctx.filesDir, "templates")

  fun get(ctx: Context): LoadedEngine = cached ?: synchronized(this) {
    cached ?: load(ctx).also {
      cached = it
      if (!it.usable) Log.e(TAG, "template engine unusable: ${it.reason}")
    }
  }

  /** Validates (TemplateEngine.fromJson) and writes atomically only when valid. */
  fun setOverride(ctx: Context, json: String): Boolean = synchronized(this) {
    if (TemplateEngine.fromJson(json) == null) return@synchronized false
    FileKeyValueStore(overrideDir(ctx)).write("idfc.json", json)
    cached = null
    true
  }

  fun clearOverride(ctx: Context) = synchronized(this) {
    File(overrideDir(ctx), "idfc.json").delete()
    cached = null
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
