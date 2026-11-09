package expo.modules.smsingest

import android.Manifest
import android.content.Context
import android.provider.Telephony
import android.util.Log
import androidx.core.app.ActivityCompat
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SmsIngestModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw IllegalStateException("No React context")

  private fun item(q: QueuedSms): Map<String, Any> = mapOf(
    "id" to q.id,
    "sender" to q.sender,
    "body" to q.body,
    "receivedAt" to q.receivedAt.toDouble(),
    "kind" to q.kind,
  )

  override fun definition() = ModuleDefinition {
    Name("SmsIngest")

    OnCreate {
      try {
        // Cheap only: the template engine (asset/file reads, regex compiles, selfTest) loads on
        // first use, off the main thread (an AsyncFunction or the receiver's executor); an
        // unusable engine is logged then and reported by engineHealth().
        Storage.housekeeping(context)
      } catch (t: Throwable) {
        Log.e(TAG, "init failed: ${t.javaClass.simpleName}")
      }
    }

    AsyncFunction("setSenderPatterns") { patterns: List<String> ->
      Storage.patterns(context).set(patterns)
    }

    AsyncFunction("getSenderPatterns") {
      Storage.patterns(context).get()
    }

    AsyncFunction("setTemplates") { json: String ->
      EngineProvider.setOverride(context, json)
    }

    AsyncFunction("resetTemplates") {
      EngineProvider.clearOverride(context)
    }

    AsyncFunction("getTemplatesInfo") {
      val l = EngineProvider.get(context)
      mapOf("source" to l.source, "version" to l.version)
    }

    AsyncFunction("engineHealth") {
      val l = EngineProvider.get(context)
      mapOf("usable" to l.usable, "reason" to l.reason)
    }

    AsyncFunction("hasPermission") {
      mapOf(
        "receive" to Perms.granted(context, Manifest.permission.RECEIVE_SMS),
        "read" to Perms.granted(context, Manifest.permission.READ_SMS),
        "notifications" to Perms.notificationsAllowed(context),
      )
    }

    // Resolves once the user has answered the system dialogs (or at once if nothing to ask).
    AsyncFunction("requestPermissions") { promise: Promise ->
      val perms = Perms.wanted()
      val mgr = appContext.permissions
      try {
        if (mgr != null) {
          mgr.askForPermissions(PermissionsResponseListener { promise.resolve(null) }, *perms)
        } else {
          val activity = appContext.currentActivity ?: throw IllegalStateException("No activity")
          ActivityCompat.requestPermissions(activity, perms, 4711)
          promise.resolve(null)
        }
      } catch (t: Throwable) {
        promise.reject("E_PERMISSIONS", t.message ?: t.javaClass.simpleName, t)
      }
    }

    AsyncFunction("peek") {
      Storage.queue(context).peek().map { item(it) }
    }

    AsyncFunction("ack") { ids: List<String> ->
      Storage.queue(context).ack(ids)
    }

    AsyncFunction("droppedCount") {
      Storage.queue(context).droppedCount().toDouble()
    }

    // Reads the SMS inbox; never writes the queue. Same drop rules as the receiver, so no OTP reaches JS.
    AsyncFunction("backfill") { days: Int, senderPatterns: List<String> ->
      backfill(days, senderPatterns)
    }
  }

  private fun backfill(days: Int, senderPatterns: List<String>): Map<String, Any> {
    val ctx = context
    val none = mapOf<String, Any>("messages" to emptyList<Map<String, Any>>(), "truncated" to false)
    if (!Perms.granted(ctx, Manifest.permission.READ_SMS)) return none
    val filter = SenderFilter(senderPatterns)
    // days == 0 is all time (no date bound); only a negative window or no sender patterns reads nothing.
    if (!filter.hasPatterns || !BackfillQuery.reads(days)) return none
    val loaded = EngineProvider.get(ctx)
    val classifier = MessageClassifier(filter, loaded.engine, loaded.usable)
    val bounds = BackfillQuery.bounds(days, System.currentTimeMillis(), Telephony.Sms.DATE)
    val out = ArrayList<Map<String, Any>>()
    var truncated = false
    val cols = arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE)
    ctx.contentResolver.query(
      Telephony.Sms.Inbox.CONTENT_URI,
      cols,
      bounds.selection,
      bounds.args,
      "${Telephony.Sms.DATE} DESC",
    )?.use { c ->
      while (c.moveToNext()) {
        val sender = c.getString(0) ?: continue
        val body = c.getString(1) ?: continue
        val date = c.getLong(2)
        if (!classifier.keep(sender, body)) continue
        // One more kept message beyond the cap proves older ones exist.
        if (out.size >= BackfillQuery.CAP) {
          truncated = true
          break
        }
        out.add(mapOf("sender" to sender, "body" to body, "receivedAt" to date.toDouble()))
      }
    }
    return mapOf("messages" to out, "truncated" to truncated)
  }
}
