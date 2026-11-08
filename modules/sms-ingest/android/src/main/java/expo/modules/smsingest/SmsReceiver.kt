package expo.modules.smsingest

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * SPIKE ONLY (Task 2): this receiver accepts SMS from ANY sender and stores/announces all of them.
 * It MUST be replaced in Task 9 by the IDFC sender filter. Do not ship this behaviour.
 *
 * No JavaScript runs here: it must work with the app process dead.
 */
class SmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
    if (parts.isEmpty()) return

    // Multipart messages: same sender, concatenate bodies.
    val sender = parts[0].originatingAddress ?: "unknown"
    val body = parts.joinToString("") { it.messageBody ?: "" }
    val ts = parts[0].timestampMillis

    synchronized(LOCK) {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val queue = try {
        JSONArray(prefs.getString(KEY, "[]"))
      } catch (e: Exception) {
        JSONArray()
      }
      queue.put(JSONObject().put("sender", sender).put("body", body).put("ts", ts))
      prefs.edit().putString(KEY, queue.toString()).commit()
    }

    notify(context, sender, body.length)
  }

  private fun notify(context: Context, sender: String, chars: Int) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL, "SMS spike", NotificationManager.IMPORTANCE_DEFAULT)
    )
    val n = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_dialog_email)
      .setContentTitle("AutoLedger spike")
      .setContentText("Spike: SMS from $sender ($chars chars)")
      .setAutoCancel(true)
      .build()
    try {
      nm.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), n)
    } catch (e: SecurityException) {
      // POST_NOTIFICATIONS not granted; the queue still holds the message.
    }
  }

  companion object {
    const val PREFS = "sms_ingest_spike"
    const val KEY = "queue"
    const val CHANNEL = "sms_spike"
    val LOCK = Any()
  }
}
